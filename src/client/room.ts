import {
  closeRoomPath,
  deleteRoomPath,
  forgetRoomPath,
  roomStatusByRoomIDPath,
} from "../server/auth-do-routes";
import { createAuthAPIHeaders } from "../server/auth-api-headers";
import type { RoomStatus } from "../server/rooms";
import type { CreateRoomRequest } from "src/protocol/api/room";

/**
 * createRoom creates a new room with the given roomID. If the room already
 * exists, an error is thrown. This call uses fetch(); you can get a Request
 * using newCreateRoomRequest.
 *
 * @param {string} reflectServerURL - The URL of the reflect server, e.g.
 *   "https://reflect.example.workers.dev".
 * @param {string} authApiKey - The auth API key for the reflect server.
 * @param {string} roomID - The ID of the room to create.
 * @param {string} [jurisdiction] - If 'eu', then the room should be created in the EU.
 *
 *   Do not set this to true unless you are sure you need it.
 */
export async function createRoom(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
  jurisdiction?: "eu"
): Promise<void> {
  const resp = await fetch(
    newCreateRoomRequest(reflectServerURL, authApiKey, roomID, jurisdiction)
  );
  if (!resp.ok) {
    throw new Error(`Failed to create room: ${resp.status} ${resp.statusText}`);
  }
  return Promise.resolve(void 0);
}

export async function closeRoom(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string
): Promise<void> {
  const resp = await fetch(
    newCloseRoomRequest(reflectServerURL, authApiKey, roomID)
  );
  if (!resp.ok) {
    throw new Error(`Failed to close room: ${resp.status} ${resp.statusText}`);
  }
  return Promise.resolve(void 0);
}

export async function deleteRoom(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string
): Promise<void> {
  const resp = await fetch(
    newDeleteRoomRequest(reflectServerURL, authApiKey, roomID)
  );
  if (!resp.ok) {
    throw new Error(`Failed to delete room: ${resp.status} ${resp.statusText}`);
  }
  return Promise.resolve(void 0);
}

/**
 * roomStatus returns the status of the room with the given roomID. This call
 * uses fetch(); you can get a Request using newRoomStatusRequest.
 *
 * @param {string} reflectServerURL - The URL of the reflect server, e.g.
 *   "https://reflect.example.workers.dev".
 * @param {string} authApiKey - The auth API key for the reflect server.
 * @param {string} roomID - The ID of the room to return status of.
 *
 * @returns {Promise<RoomStatus>} - The status of the room.
 */
export async function roomStatus(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string
): Promise<RoomStatus> {
  const resp = await fetch(
    newRoomStatusRequest(reflectServerURL, authApiKey, roomID)
  );
  if (!resp.ok) {
    throw new Error(
      `Failed to get room status: ${resp.status} ${resp.statusText}`
    );
  }
  return resp.json();
}

/**
 * Returns a new Request for roomStatus.
 *
 * @param {string} reflectServerURL - The URL of the reflect server, e.g.
 *   "https://reflect.example.workers.dev".
 * @param {string} authApiKey - The auth API key for the reflect server.
 * @param {string} roomID - The ID of the room to return status of.
 * @returns {Request} - The Request to get room status.
 */
export function newRoomStatusRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string
) {
  const path = roomStatusByRoomIDPath.replace(":roomID", roomID);
  const url = new URL(path, reflectServerURL);
  return new Request(url.toString(), {
    method: "get",
    headers: createAuthAPIHeaders(authApiKey),
  });
}

/**
 * Returns a new Request for createRoom.
 *
 * @param {string} reflectServerURL - The URL of the reflect server, e.g.
 *   "https://reflect.example.workers.dev".
 * @param {string} authApiKey - The auth API key for the reflect server.
 * @param {string} roomID - The ID of the room to create.
 * @param {string} [jurisdiction] - If 'eu' then the room should be created
 *   in the EU. Do not set this unless you are sure you need it.
 * @returns {Request} - The Request to create the room.
 */
export function newCreateRoomRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
  jurisdiction?: "eu"
) {
  const url = new URL("/createRoom", reflectServerURL);
  const req: CreateRoomRequest = { roomID, jurisdiction };
  return new Request(url.toString(), {
    method: "post",
    headers: createAuthAPIHeaders(authApiKey),
    body: JSON.stringify(req),
  });
}

export function newCloseRoomRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string
) {
  const path = closeRoomPath.replace(":roomID", roomID);
  const url = new URL(path, reflectServerURL);
  return new Request(url.toString(), {
    method: "post",
    headers: createAuthAPIHeaders(authApiKey),
  });
}

export function newDeleteRoomRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string
) {
  const path = deleteRoomPath.replace(":roomID", roomID);
  const url = new URL(path, reflectServerURL);
  return new Request(url.toString(), {
    method: "post",
    headers: createAuthAPIHeaders(authApiKey),
  });
}

export function newForgetRoomRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string
) {
  const path = forgetRoomPath.replace(":roomID", roomID);
  const url = new URL(path, reflectServerURL);
  return new Request(url.toString(), {
    method: "post",
    headers: createAuthAPIHeaders(authApiKey),
  });
}
