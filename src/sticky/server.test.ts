import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as netCreateServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";

import { AGENT_STATE_UUID, SERVICE_UUID } from "./protocol.ts";
import {
  ENV_STICKY_SOCKET,
  MAX_DEVICES,
  parseWriteResponse,
  ServerAbsentError,
  SocketStickyServer,
  socketStickyServer,
  stickySocketPath,
} from "./server.ts";

const execFileAsync = promisify(execFile);

describe("stickySocketPath", () => {
  it("uses STICKY_SOCKET when it is set", () => {
    assert.equal(stickySocketPath({ [ENV_STICKY_SOCKET]: "/tmp/s" }, "linux"), "/tmp/s");
  });

  it("uses the default path on macOS only", () => {
    assert.match(stickySocketPath({}, "darwin") ?? "", /Library\/Caches\/sticky\/S\.sticky$/);
    assert.equal(stickySocketPath({}, "linux"), undefined);
    assert.equal(stickySocketPath({ [ENV_STICKY_SOCKET]: "" }, "linux"), undefined);
  });
});

describe("parseWriteResponse", () => {
  it("reads the result of each sticky", () => {
    assert.deepEqual(
      parseWriteResponse({
        write: {
          devices: [
            { name: null, identifier: "A", error: "busy (ATT error 0x80)" },
            { name: "Sticky", identifier: "B", error: null },
          ],
        },
      }),
      [
        { identifier: "A", error: "busy (ATT error 0x80)" },
        { identifier: "B", error: null },
      ],
    );
  });

  it("rejects with the message of an error response", () => {
    assert.throws(() => parseWriteResponse({ error: { message: "found no sticky in 10 s" } }), /found no sticky in 10 s/);
  });

  it("rejects a response that it does not know", () => {
    assert.throws(() => parseWriteResponse([]), /not a write response/);
    assert.throws(() => parseWriteResponse({ read: {} }), /not a write response/);
  });

  it("reads the first stickies only", () => {
    const devices = Array.from({ length: MAX_DEVICES + 5 }, (_, i) => ({ identifier: `D${i}`, error: null }));
    assert.equal(parseWriteResponse({ write: { devices } }).length, MAX_DEVICES);
  });

  it("does not trust the types of the items", () => {
    assert.deepEqual(parseWriteResponse({ write: { devices: [{ identifier: 3, error: 4 }, "x"] } }), [
      { identifier: "?", error: "not known" },
      { identifier: "?", error: "not an object" },
    ]);
  });
});

describe("SocketStickyServer", () => {
  /** `net.createServer`, but the test closes all connections at the end. */
  function createServer(handler: (socket: Socket) => void): Server {
    return netCreateServer((socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      handler(socket);
    });
  }

  let dir: string;
  let path: string;
  let server: Server | undefined;
  /** The request lines that the fake server got. */
  let requests: string[];
  const connections = new Set<Socket>();

  beforeEach(async () => {
    // A short path: macOS accepts socket paths of 103 bytes at most.
    dir = await mkdtemp("/tmp/tau-sticky-");
    await chmod(dir, 0o700);
    path = join(dir, "S.sticky");
    requests = [];
  });

  afterEach(async () => {
    // Close the open connections first: else server.close() waits for them.
    for (const socket of connections) socket.destroy();
    connections.clear();
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** Starts a fake server. `answer` gives the response line for a request line (`undefined`: no answer). */
  async function listen(answer: (line: string) => string | undefined): Promise<void> {
    server = createServer((socket) => {
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        const end = data.indexOf("\n");
        if (end === -1) return;
        const line = data.slice(0, end);
        requests.push(line);
        const response = answer(line);
        if (response !== undefined) socket.end(response);
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server!.listen(path, resolve));
  }

  it("sends one write request, and reads the response", async () => {
    await listen(() => `${JSON.stringify({ write: { devices: [{ name: "S", identifier: "A", error: null }] } })}\n`);
    const client = new SocketStickyServer({ path, defaultPath: true });
    const result = await client.write(AGENT_STATE_UUID, Buffer.from([3, 115, 45, 49, 2]));
    assert.deepEqual(result, [{ identifier: "A", error: null }]);
    assert.deepEqual(
      requests.map((line) => JSON.parse(line)),
      [
        {
          version: 2,
          command: {
            write: { attribute: { service: SERVICE_UUID, characteristic: AGENT_STATE_UUID }, value: [3, 115, 45, 49, 2] },
          },
        },
      ],
    );
  });

  it("reads a response in more than one part", async () => {
    server = createServer((socket) => {
      socket.once("data", () => {
        socket.write('{"write":{"devi');
        setTimeout(() => socket.end('ces":[]}}\n'), 10);
      });
    });
    await new Promise<void>((resolve) => server!.listen(path, resolve));
    const client = new SocketStickyServer({ path, defaultPath: true });
    assert.deepEqual(await client.write(AGENT_STATE_UUID, Buffer.from([1])), []);
  });

  it("rejects with ServerAbsentError when there is no socket, and does not make one", async () => {
    const client = new SocketStickyServer({ path, defaultPath: true });
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), ServerAbsentError);
  });

  it("rejects with ServerAbsentError when the file is not a socket", async () => {
    await writeFile(path, "");
    const client = new SocketStickyServer({ path, defaultPath: true });
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), /is not a socket/);
  });

  it("rejects with ServerAbsentError when the socket belongs to a different user", async () => {
    await listen(() => "{}\n");
    const client = new SocketStickyServer({ path, defaultPath: false, uid: (process.getuid?.() ?? 0) + 1 });
    // The directories of the test belong to the user of the test too.
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), ServerAbsentError);
    assert.deepEqual(requests, []);
  });

  it("rejects a default directory that other users can open", async () => {
    await listen(() => "{}\n");
    await chmod(dir, 0o755);
    const client = new SocketStickyServer({ path, defaultPath: true });
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), /not a private directory/);
    // STICKY_SOCKET: the user is responsible for the directory.
    const custom = new SocketStickyServer({ path, defaultPath: false });
    await assert.rejects(custom.write(AGENT_STATE_UUID, Buffer.from([1])), /not a write response/);
  });

  it("rejects a default directory that is a symbolic link", async () => {
    const real = join(dir, "real");
    await mkdir(real, { mode: 0o700 });
    const link = join(dir, "link");
    await symlink(real, link);
    path = join(real, "S.sticky");
    await listen(() => "{}\n");
    const client = new SocketStickyServer({ path: join(link, "S.sticky"), defaultPath: true });
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), /not a private directory/);
  });

  it("rejects with ServerAbsentError after the server stopped", async () => {
    await listen(() => undefined);
    const old = server!;
    server = undefined;
    // Node removes the socket file at the close: no file.
    await new Promise<void>((resolve) => old.close(() => resolve()));
    const client = new SocketStickyServer({ path, defaultPath: true });
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), ServerAbsentError);
  });

  it("rejects with ServerAbsentError when the socket stays after the server stopped (connection refused)", async () => {
    // A process that listens, then stops without removing the socket file.
    const code = `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"));`;
    await execFileAsync(process.execPath, ["-e", code]).catch(() => undefined);
    assert.equal((await lstat(path)).isSocket(), true);
    const client = new SocketStickyServer({ path, defaultPath: true });
    const error = await client.write(AGENT_STATE_UUID, Buffer.from([1])).catch((e: unknown) => e);
    assert.ok(error instanceof ServerAbsentError, String(error));
    assert.match(error.message, /ECONNREFUSED/);
  });

  it("rejects a STICKY_SOCKET directory that other users can write to", async () => {
    await listen(() => "{}\n");
    await chmod(dir, 0o777);
    const custom = new SocketStickyServer({ path, defaultPath: false });
    await assert.rejects(custom.write(AGENT_STATE_UUID, Buffer.from([1])), /other users can replace the socket/);
    assert.deepEqual(requests, []);
    // With the sticky bit (as /tmp), other users cannot replace the socket.
    await chmod(dir, 0o1777);
    await assert.rejects(custom.write(AGENT_STATE_UUID, Buffer.from([1])), /not a write response/);
  });

  it("connects through the real path of a STICKY_SOCKET with a symbolic link", async () => {
    await listen(() => `${JSON.stringify({ write: { devices: [] } })}\n`);
    const link = join(dir, "link");
    await symlink(dir, link);
    const custom = new SocketStickyServer({ path: join(link, "S.sticky"), defaultPath: false });
    assert.deepEqual(await custom.write(AGENT_STATE_UUID, Buffer.from([1])), []);
  });

  it("rejects a STICKY_SOCKET path when other users can change a directory of its real path", async () => {
    // dir (others can write) / private (0700, the socket): another user can
    // replace "private" in dir.
    const inner = join(dir, "private");
    await mkdir(inner, { mode: 0o700 });
    path = join(inner, "S.sticky");
    await listen(() => "{}\n");
    await chmod(dir, 0o777);
    const custom = new SocketStickyServer({ path, defaultPath: false });
    await assert.rejects(custom.write(AGENT_STATE_UUID, Buffer.from([1])), new RegExp(`other users can replace the socket in .*${dir.split("/").at(-1)}$`));
    assert.deepEqual(requests, []);
  });

  it("does not connect when the close comes during the socket checks", async () => {
    await listen(() => "{}\n");
    const client = new SocketStickyServer({ path, defaultPath: true });
    const pending = client.write(AGENT_STATE_UUID, Buffer.from([1]));
    client.close();
    await assert.rejects(pending, /closed/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(requests, []);
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), /closed/);
  });

  it("rejects after its time when the server does not answer", async () => {
    await listen(() => undefined);
    const client = new SocketStickyServer({ path, defaultPath: true, requestMs: 50 });
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), /no response in 50 ms/);
  });

  it("rejects when the server closes the connection without a response", async () => {
    await listen(() => "");
    const client = new SocketStickyServer({ path, defaultPath: true });
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), /closed the connection/);
  });

  it("rejects a response that is not JSON, or too long", async () => {
    await listen(() => "nope\n");
    const client = new SocketStickyServer({ path, defaultPath: true });
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), /not JSON/);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    await listen(() => "x".repeat(2 * 1024 * 1024));
    await assert.rejects(client.write(AGENT_STATE_UUID, Buffer.from([1])), /too long/);
  });

  it("close stops the requests that run now", async () => {
    await listen(() => undefined);
    const client = new SocketStickyServer({ path, defaultPath: true });
    const pending = client.write(AGENT_STATE_UUID, Buffer.from([1]));
    // At most 2 s: when the connection fails, the test fails (it does not wait for ever).
    const deadline = Date.now() + 2_000;
    try {
      while (requests.length === 0) {
        assert.ok(Date.now() < deadline, "the server got no request");
        await Promise.race([pending.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5))]);
      }
    } finally {
      client.close();
    }
    await assert.rejects(pending, /closed the connection/);
  });

  it("socketStickyServer checks the directory only for the default path", () => {
    assert.equal(socketStickyServer({}) === undefined, process.platform !== "darwin");
    assert.ok(socketStickyServer({ [ENV_STICKY_SOCKET]: path }) instanceof SocketStickyServer);
  });
});
