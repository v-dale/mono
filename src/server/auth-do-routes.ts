import type { BaseAuthDO } from "./auth-do";
import {
  RociRequest,
  RociRouter,
  requireAuthAPIKeyMatches,
} from "./middleware";

type Route = {
  path: string;
  add: (
    router: RociRouter,
    authDO: BaseAuthDO,
    authApiKey: string | undefined
  ) => void;
};
const routes: Route[] = [];

// Note: paths may have router-style path parameters, e.g. /foo/:bar.
export function paths() {
  return routes.map((route) => route.path);
}

// Called by the authDO to set up its routes.
export function addRoutes(
  router: RociRouter,
  authDO: BaseAuthDO,
  authApiKey: string | undefined
) {
  routes.forEach((route) => route.add(router, authDO, authApiKey));
}

// Note: we define the path and the handler in the same place like this
// so it's easy to understand what each route does.

export const roomStatusByRoomIDPath = "/api/room/v0/room/:roomID/status";
routes.push({
  path: roomStatusByRoomIDPath,
  add: (
    router: RociRouter,
    authDO: BaseAuthDO,
    authApiKey: string | undefined
  ) => {
    router.get(
      roomStatusByRoomIDPath,
      requireAuthAPIKeyMatches(authApiKey),
      async (request: RociRequest) => {
        return authDO.roomStatusByRoomID(request);
      }
    );
  },
});

export const roomRecordsPath = "/api/room/v0/rooms";
routes.push({
  path: roomRecordsPath,
  add: (
    router: RociRouter,
    authDO: BaseAuthDO,
    authApiKey: string | undefined
  ) => {
    router.get(
      roomRecordsPath,
      requireAuthAPIKeyMatches(authApiKey),
      async (request: RociRequest) => {
        return authDO.allRoomRecords(request);
      }
    );
  },
});

// A call to closeRoom should be followed by a call to
// authInvalidateForRoom to ensure users are logged out.
export const closeRoomPath = "/api/room/v0/room/:roomID/close";
routes.push({
  path: closeRoomPath,
  add: (
    router: RociRouter,
    authDO: BaseAuthDO,
    authApiKey: string | undefined
  ) => {
    router.post(
      closeRoomPath,
      requireAuthAPIKeyMatches(authApiKey),
      async (request: RociRequest) => {
        // TODO should plumb a LogContext through here.
        return authDO.closeRoom(request);
      }
    );
  },
});

// A room must first be closed before it can be deleted.
export const deleteRoomPath = "/api/room/v0/room/:roomID/delete";
routes.push({
  path: deleteRoomPath,
  add: (
    router: RociRouter,
    authDO: BaseAuthDO,
    authApiKey: string | undefined
  ) => {
    router.post(
      deleteRoomPath,
      requireAuthAPIKeyMatches(authApiKey),
      async (request: RociRequest) => {
        // TODO should plumb a LogContext through here.
        return authDO.deleteRoom(request);
      }
    );
  },
});

// This is a DANGEROUS call: it removes the RoomRecord for the given
// room, potentially orphaning the roomDO. It doesn't log users out
// or delete the room's data, it just forgets about the room.
// It is useful if you are testing migration, or if you are developing
// in reflect-server.
export const forgetRoomPath = "/api/room/v0/room/:roomID/DANGER/forget";
routes.push({
  path: forgetRoomPath,
  add: (
    router: RociRouter,
    authDO: BaseAuthDO,
    authApiKey: string | undefined
  ) => {
    router.post(
      forgetRoomPath,
      requireAuthAPIKeyMatches(authApiKey),
      async (request: RociRequest) => {
        return authDO.forgetRoom(request);
      }
    );
  },
});
