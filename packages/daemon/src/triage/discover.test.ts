import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  candidateSockets,
  compatibleStatus,
  discover,
  probe,
  socketFor,
} from "./discover.ts";

const STATUS_REQUEST = '{"jsonrpc":"2.0","id":1,"method":"chauffeur.status"}\n';
const directories: string[] = [];
const servers = new Set<Server>();
const connections = new Set<Socket>();

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sf-"));
  directories.push(directory);
  return directory;
}

function listen(
  socket: string,
  onConnection: (connection: Socket) => void,
): Promise<Server> {
  mkdirSync(path.dirname(socket), { recursive: true });
  const server = createServer((connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {});
    onConnection(connection);
  });
  servers.add(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function statusServer(
  socket: string,
  reply: (request: string) => string,
): Promise<string[]> {
  const requests: string[] = [];
  return listen(socket, (connection) => {
    let pending = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: Buffer | string) => {
      pending += chunk.toString();
      const newline = pending.indexOf("\n");
      if (newline === -1) return;

      const request = pending.slice(0, newline + 1);
      requests.push(request);
      connection.write(`${reply(request)}\n`);
    });
  }).then(() => requests);
}

function status(version: string, protocol = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { version, protocol, rules: [] },
  });
}

function serveStatus(
  socket: string,
  version: string,
  protocol = 1,
): Promise<string[]> {
  return statusServer(socket, () => status(version, protocol));
}

after(async () => {
  for (const connection of connections) connection.destroy();
  connections.clear();
  await Promise.all(
    [...servers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("candidateSockets", () => {
  test("an explicit CHAUFFEUR_SOCKET is the only candidate", () => {
    assert.deepEqual(
      candidateSockets({
        CHAUFFEUR_SOCKET: "/x/s.sock",
        XDG_RUNTIME_DIR: "/r",
      }),
      ["/x/s.sock"],
    );
  });

  test("uses XDG_RUNTIME_DIR when it is set", () => {
    assert.deepEqual(candidateSockets({ XDG_RUNTIME_DIR: "/run/user/501" }), [
      "/run/user/501/chauffeur/daemon.sock",
      "/run/user/501/chauffeur-next/daemon.sock",
    ]);
  });

  test("falls back to the temporary folder", () => {
    assert.deepEqual(candidateSockets({}), [
      path.join(os.tmpdir(), "chauffeur", "daemon.sock"),
      path.join(os.tmpdir(), "chauffeur-next", "daemon.sock"),
    ]);
  });

  test("an empty CHAUFFEUR_SOCKET is ignored", () => {
    assert.deepEqual(
      candidateSockets({
        CHAUFFEUR_SOCKET: "",
        XDG_RUNTIME_DIR: "/run/user/501",
      }),
      [
        "/run/user/501/chauffeur/daemon.sock",
        "/run/user/501/chauffeur-next/daemon.sock",
      ],
    );
  });
});

describe("socketFor", () => {
  test("builds a named socket from XDG_RUNTIME_DIR", () => {
    assert.equal(
      socketFor("chauffeur-next", { XDG_RUNTIME_DIR: "/run/user/501" }),
      "/run/user/501/chauffeur-next/daemon.sock",
    );
  });

  test("falls back to the temporary folder, including for an empty XDG_RUNTIME_DIR", () => {
    assert.equal(
      socketFor("chauffeur", {}),
      path.join(os.tmpdir(), "chauffeur", "daemon.sock"),
    );
    assert.equal(
      socketFor("chauffeur", { XDG_RUNTIME_DIR: "" }),
      path.join(os.tmpdir(), "chauffeur", "daemon.sock"),
    );
  });
});

describe("compatibleStatus", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["a v2 release candidate", { protocol: 1, version: "1.0.0-rc.4" }, true],
    ["a v2 release", { protocol: 1, version: "1.2.3" }, true],
    [
      "a v2 release with build metadata",
      { protocol: 1, version: "1.2.3+build.5" },
      true,
    ],
    ["a v1 daemon", { protocol: 1, version: "0.1.0" }, false],
    ["a v2 major", { protocol: 1, version: "2.0.0" }, false],
    ["a short version", { protocol: 1, version: "1.0" }, false],
    ["another protocol", { protocol: 2, version: "1.2.3" }, false],
    ["a missing version", { protocol: 1 }, false],
    ["null", null, false],
    ["a string", "1.2.3", false],
  ];

  for (const [name, value, expected] of cases) {
    test(`${expected ? "accepts" : "rejects"} ${name}`, () => {
      assert.equal(compatibleStatus(value), expected);
    });
  }
});

describe("probe", () => {
  test("reports a v2 daemon's socket and version", async () => {
    const socket = path.join(temporaryDirectory(), "daemon.sock");
    const requests = await statusServer(
      socket,
      () =>
        '{"jsonrpc":"2.0","id":1,"result":{"version":"1.0.0-rc.4","protocol":1,"rules":[]}}',
    );

    assert.deepEqual(await probe(socket), { socket, version: "1.0.0-rc.4" });
    assert.deepEqual(requests, [STATUS_REQUEST]);
  });

  test("returns undefined for a v1 version", async () => {
    const socket = path.join(temporaryDirectory(), "daemon.sock");
    await serveStatus(socket, "0.1.0");

    assert.equal(await probe(socket), undefined);
  });

  test("returns undefined for another protocol", async () => {
    const socket = path.join(temporaryDirectory(), "daemon.sock");
    await serveStatus(socket, "1.2.3", 2);

    assert.equal(await probe(socket), undefined);
  });

  test("returns undefined for a JSON-RPC error reply", async () => {
    const socket = path.join(temporaryDirectory(), "daemon.sock");
    await statusServer(
      socket,
      () =>
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"unknown method"}}',
    );

    assert.equal(await probe(socket), undefined);
  });

  test("returns undefined for invalid JSON", async () => {
    const socket = path.join(temporaryDirectory(), "daemon.sock");
    await statusServer(socket, () => "not json");

    assert.equal(await probe(socket), undefined);
  });

  test("returns undefined for a silent daemon within the timeout", async () => {
    const socket = path.join(temporaryDirectory(), "daemon.sock");
    await listen(socket, () => {});
    const started = Date.now();

    assert.equal(await probe(socket), undefined);
    assert.ok(
      Date.now() - started < 1_500,
      `probe took ${Date.now() - started} ms`,
    );
  });

  test("returns undefined for an oversized status reply", async () => {
    const socket = path.join(temporaryDirectory(), "daemon.sock");
    await listen(socket, (connection) => {
      connection.once("data", () => connection.write("x".repeat(70 * 1024)));
    });

    assert.equal(await probe(socket), undefined);
  });

  test("returns undefined when no daemon is listening", async () => {
    assert.equal(
      await probe(path.join(temporaryDirectory(), "missing.sock")),
      undefined,
    );
  });

  test("returns undefined when the server closes at once", async () => {
    const socket = path.join(temporaryDirectory(), "daemon.sock");
    await listen(socket, (connection) => connection.destroy());

    assert.equal(await probe(socket), undefined);
  });
});

describe("discover", () => {
  test("skips a v1 daemon and finds the v2 daemon beside it", async () => {
    const runtime = temporaryDirectory();
    const v1 = path.join(runtime, "chauffeur", "daemon.sock");
    const v2 = path.join(runtime, "chauffeur-next", "daemon.sock");
    await serveStatus(v1, "0.9.3");
    await serveStatus(v2, "1.0.0-rc.4");

    assert.deepEqual(await discover({ XDG_RUNTIME_DIR: runtime }), {
      socket: v2,
      version: "1.0.0-rc.4",
    });
  });

  test("finds the v2 daemon in the first candidate socket", async () => {
    const runtime = temporaryDirectory();
    const socket = path.join(runtime, "chauffeur", "daemon.sock");
    await serveStatus(socket, "1.2.3");

    assert.deepEqual(await discover({ XDG_RUNTIME_DIR: runtime }), {
      socket,
      version: "1.2.3",
    });
  });

  test("an explicit CHAUFFEUR_SOCKET is exclusive", async () => {
    const runtime = temporaryDirectory();
    const explicit = path.join(runtime, "explicit.sock");
    const v2 = path.join(runtime, "chauffeur-next", "daemon.sock");
    await serveStatus(explicit, "0.9.3");
    const requests = await serveStatus(v2, "1.2.3");

    assert.equal(
      await discover({ CHAUFFEUR_SOCKET: explicit, XDG_RUNTIME_DIR: runtime }),
      undefined,
    );
    assert.deepEqual(requests, []);
  });
});
