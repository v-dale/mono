import * as db from '../db/mod';
import type {Hash} from '../hash';
import type * as dag from '../dag/mod';
import type * as btree from '../btree/mod';
import type {HashRefType} from '../db/hash-ref-type';
import type {Meta} from '../db/commit';

export class GatherVisitor extends db.Visitor {
  private readonly _gatheredChunks: Map<Hash, dag.Chunk<unknown>> = new Map();
  private readonly _lazyRead: dag.LazyRead;

  constructor(dagRead: dag.LazyRead) {
    super(dagRead);
    this._lazyRead = dagRead;
  }

  get gatheredChunks(): ReadonlyMap<Hash, dag.Chunk<unknown>> {
    return this._gatheredChunks;
  }

  override async visitCommit(
    h: Hash,
    hashRefType?: HashRefType,
  ): Promise<void> {
    if (!this._lazyRead.isMemOnlyChunkHash(h)) {
      // Not a memory-only hash, no need to visit anything else.
      return;
    }
    return super.visitCommit(h, hashRefType);
  }

  override async visitCommitChunk(
    chunk: dag.Chunk<db.CommitData<Meta>>,
  ): Promise<void> {
    this._gatheredChunks.set(chunk.hash, chunk);
    return super.visitCommitChunk(chunk);
  }

  override async visitBTreeNode(h: Hash): Promise<void> {
    if (!this._lazyRead.isMemOnlyChunkHash(h)) {
      // Not a memory-only hash, no need to visit anything else.
      return;
    }

    return super.visitBTreeNode(h);
  }

  override async visitBTreeNodeChunk(
    chunk: dag.Chunk<btree.Node>,
  ): Promise<void> {
    this._gatheredChunks.set(chunk.hash, chunk);
    return super.visitBTreeNodeChunk(chunk);
  }
}
