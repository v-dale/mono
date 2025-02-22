import {Lock} from '@rocicorp/lock';
import type {LogContext} from '@rocicorp/logger';
import type {
  PatchOperationInternal,
  PokeInternal,
} from '../../../replicache/src/impl.js';
import type {ClientID, PatchOperation} from '../../../replicache/src/mod.js';
import {getBrowserGlobalMethod} from '../../../shared/src/browser-env.js';
import type {
  ClientsPatchOp,
  PokeEndBody,
  PokePartBody,
  PokeStartBody,
  QueriesPatchOp,
  RowPatchOp,
} from '../../../zero-protocol/src/mod.js';
import {
  toClientsKey,
  toDesiredQueriesKey,
  toGotQueriesKey,
  toPrimaryKeyString,
} from './keys.js';
import type {Schema} from '../../../zero-schema/src/builder/schema-builder.js';

type PokeAccumulator = {
  readonly pokeStart: PokeStartBody;
  readonly parts: PokePartBody[];
};

/**
 * Handles the multi-part format of zero pokes.
 * As an optimization it also debounces pokes, only poking Replicache with a
 * merged poke at most once per frame (as determined by requestAnimationFrame).
 * The client cannot control how fast the server sends pokes, and it can only
 * update the UI once per frame. This debouncing avoids wastefully
 * computing separate diffs and IVM updates for intermediate states that will
 * never been displayed to the UI.
 */
export class PokeHandler {
  readonly #replicachePoke: (poke: PokeInternal) => Promise<void>;
  readonly #onPokeError: () => void;
  readonly #clientID: ClientID;
  readonly #lc: LogContext;
  #receivingPoke: PokeAccumulator | undefined = undefined;
  readonly #pokeBuffer: PokeAccumulator[] = [];
  #pokePlaybackLoopRunning = false;
  #lastRafPerfTimestamp = 0;
  // Serializes calls to this.#replicachePoke otherwise we can cause out of
  // order poke errors.
  readonly #pokeLock = new Lock();
  readonly #schema: Schema;

  readonly #raf =
    getBrowserGlobalMethod('requestAnimationFrame') ?? rafFallback;

  constructor(
    replicachePoke: (poke: PokeInternal) => Promise<void>,
    onPokeError: () => void,
    clientID: ClientID,
    schema: Schema,
    lc: LogContext,
  ) {
    this.#replicachePoke = replicachePoke;
    this.#onPokeError = onPokeError;
    this.#clientID = clientID;
    this.#schema = schema;
    this.#lc = lc.withContext('PokeHandler');
  }

  handlePokeStart(pokeStart: PokeStartBody) {
    if (this.#receivingPoke) {
      this.#handlePokeError(
        `pokeStart ${JSON.stringify(
          pokeStart,
        )} while still receiving  ${JSON.stringify(
          this.#receivingPoke.pokeStart,
        )} `,
      );
      return;
    }
    this.#receivingPoke = {
      pokeStart,
      parts: [],
    };
  }

  handlePokePart(pokePart: PokePartBody): number | undefined {
    if (pokePart.pokeID !== this.#receivingPoke?.pokeStart.pokeID) {
      this.#handlePokeError(
        `pokePart for ${pokePart.pokeID}, when receiving ${this.#receivingPoke
          ?.pokeStart.pokeID}`,
      );
      return;
    }
    this.#receivingPoke.parts.push(pokePart);
    return pokePart.lastMutationIDChanges?.[this.#clientID];
  }

  handlePokeEnd(pokeEnd: PokeEndBody) {
    if (pokeEnd.pokeID !== this.#receivingPoke?.pokeStart.pokeID) {
      this.#handlePokeError(
        `pokeEnd for ${pokeEnd.pokeID}, when receiving ${this.#receivingPoke
          ?.pokeStart.pokeID}`,
      );
      return;
    }
    if (pokeEnd.cancel) {
      this.#receivingPoke = undefined;
      return;
    }
    this.#pokeBuffer.push(this.#receivingPoke);
    this.#receivingPoke = undefined;
    if (!this.#pokePlaybackLoopRunning) {
      this.#startPlaybackLoop();
    }
  }

  handleDisconnect(): void {
    this.#lc.debug?.('clearing due to disconnect');
    this.#clear();
  }

  #startPlaybackLoop() {
    this.#lc.debug?.('starting playback loop');
    this.#pokePlaybackLoopRunning = true;
    this.#raf(this.#rafCallback);
  }

  #rafCallback = async () => {
    const rafLC = this.#lc.withContext('rafAt', Math.floor(performance.now()));
    if (this.#pokeBuffer.length === 0) {
      rafLC.debug?.('stopping playback loop');
      this.#pokePlaybackLoopRunning = false;
      return;
    }
    this.#raf(this.#rafCallback);
    const start = performance.now();
    rafLC.debug?.(
      'raf fired, processing pokes.  Since last raf',
      start - this.#lastRafPerfTimestamp,
    );
    this.#lastRafPerfTimestamp = start;
    await this.#processPokesForFrame(rafLC);
    rafLC.debug?.('processing pokes took', performance.now() - start);
  };

  #processPokesForFrame(lc: LogContext): Promise<void> {
    return this.#pokeLock.withLock(async () => {
      const now = Date.now();
      lc.debug?.('got poke lock at', now);
      lc.debug?.('merging', this.#pokeBuffer.length);
      try {
        const merged = mergePokes(this.#pokeBuffer, this.#schema);
        this.#pokeBuffer.length = 0;
        if (merged === undefined) {
          lc.debug?.('frame is empty');
          return;
        }
        const start = performance.now();
        lc.debug?.('poking replicache');
        await this.#replicachePoke(merged);
        lc.debug?.('poking replicache took', performance.now() - start);
      } catch (e) {
        this.#handlePokeError(e);
      }
    });
  }

  #handlePokeError(e: unknown) {
    if (String(e).includes('unexpected base cookie for poke')) {
      // This can happen if cookie changes due to refresh from idb due
      // to an update arriving to different tabs in the same
      // client group at very different times.  Unusual but possible.
      this.#lc.debug?.('clearing due to', e);
    } else {
      this.#lc.error?.('clearing due to unexpected poke error', e);
    }
    this.#clear();
    this.#onPokeError();
  }

  #clear() {
    this.#receivingPoke = undefined;
    this.#pokeBuffer.length = 0;
  }
}

export function mergePokes(
  pokeBuffer: PokeAccumulator[],
  schema: Schema,
): PokeInternal | undefined {
  if (pokeBuffer.length === 0) {
    return undefined;
  }
  const {baseCookie} = pokeBuffer[0].pokeStart;
  const {cookie} = pokeBuffer[pokeBuffer.length - 1].pokeStart;
  const mergedPatch: PatchOperationInternal[] = [];
  const mergedLastMutationIDChanges: Record<string, number> = {};

  let prevPokeStart = undefined;
  for (const pokeAccumulator of pokeBuffer) {
    if (
      prevPokeStart &&
      pokeAccumulator.pokeStart.baseCookie &&
      pokeAccumulator.pokeStart.baseCookie > prevPokeStart.cookie
    ) {
      throw Error(
        `unexpected cookie gap ${JSON.stringify(
          prevPokeStart,
        )} ${JSON.stringify(pokeAccumulator.pokeStart)}`,
      );
    }
    prevPokeStart = pokeAccumulator.pokeStart;
    for (const pokePart of pokeAccumulator.parts) {
      if (pokePart.lastMutationIDChanges) {
        for (const [clientID, lastMutationID] of Object.entries(
          pokePart.lastMutationIDChanges,
        )) {
          mergedLastMutationIDChanges[clientID] = lastMutationID;
        }
      }
      if (pokePart.clientsPatch) {
        mergedPatch.push(
          ...pokePart.clientsPatch.map(clientsPatchOpToReplicachePatchOp),
        );
      }
      if (pokePart.desiredQueriesPatches) {
        for (const [clientID, queriesPatch] of Object.entries(
          pokePart.desiredQueriesPatches,
        )) {
          mergedPatch.push(
            ...queriesPatch.map(op =>
              queryPatchOpToReplicachePatchOp(op, hash =>
                toDesiredQueriesKey(clientID, hash),
              ),
            ),
          );
        }
      }
      if (pokePart.gotQueriesPatch) {
        mergedPatch.push(
          ...pokePart.gotQueriesPatch.map(op =>
            queryPatchOpToReplicachePatchOp(op, toGotQueriesKey),
          ),
        );
      }
      if (pokePart.rowsPatch) {
        mergedPatch.push(
          ...pokePart.rowsPatch.map(p =>
            rowsPatchOpToReplicachePatchOp(p, schema),
          ),
        );
      }
    }
  }
  return {
    baseCookie,
    pullResponse: {
      lastMutationIDChanges: mergedLastMutationIDChanges,
      patch: mergedPatch,
      cookie,
    },
  };
}

function clientsPatchOpToReplicachePatchOp(op: ClientsPatchOp): PatchOperation {
  switch (op.op) {
    case 'clear':
      return op;
    case 'del':
      return {
        op: 'del',
        key: toClientsKey(op.clientID),
      };
    case 'put':
    default:
      return {
        op: 'put',
        key: toClientsKey(op.clientID),
        value: true,
      };
  }
}

function queryPatchOpToReplicachePatchOp(
  op: QueriesPatchOp,
  toKey: (hash: string) => string,
): PatchOperation {
  switch (op.op) {
    case 'clear':
      return op;
    case 'del':
      return {
        op: 'del',
        key: toKey(op.hash),
      };
    case 'put':
    default:
      return {
        op: 'put',
        key: toKey(op.hash),
        value: op.ast,
      };
  }
}

function rowsPatchOpToReplicachePatchOp(
  op: RowPatchOp,
  schema: Schema,
): PatchOperationInternal {
  switch (op.op) {
    case 'clear':
      return op;
    case 'del':
      return {
        op: 'del',
        key: toPrimaryKeyString(
          op.tableName,
          schema.tables[op.tableName].primaryKey,
          op.id,
        ),
      };
    case 'put':
      return {
        op: 'put',
        key: toPrimaryKeyString(
          op.tableName,
          schema.tables[op.tableName].primaryKey,
          op.value,
        ),
        value: op.value,
      };
    case 'update':
      return {
        op: 'update',
        key: toPrimaryKeyString(
          op.tableName,
          schema.tables[op.tableName].primaryKey,
          op.id,
        ),
        merge: op.merge,
        constrain: op.constrain,
      };
    default:
      throw new Error('to be implemented');
  }
}

/**
 * Some environments we run in don't have `requestAnimationFrame` (such as
 * Node, Cloudflare Workers).
 */
function rafFallback(callback: () => void): void {
  setTimeout(callback, 0);
}
