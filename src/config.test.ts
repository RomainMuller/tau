import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { configFor, DEFAULT_CONFIG, isKeyId, loadConfig, MAX_CONFIG_BYTES, parseConfig, stripComments } from "./config.ts";

describe("stripComments", () => {
  it("removes line and block comments, and keeps text in strings", () => {
    const text = [
      "{",
      '  // a comment',
      '  "a": "http://x", /* block',
      '  comment */ "b": "/* not a comment */",',
      '  "c": "quote \\" // still a string"',
      "}",
    ].join("\n");
    assert.deepEqual(JSON.parse(stripComments(text)), { a: "http://x", b: "/* not a comment */", c: 'quote " // still a string' });
  });

  it("keeps the line feeds, so that error positions stay correct", () => {
    assert.equal(stripComments("a // x\nb /* y\nz */ c"), "a  \nb  \n c");
  });

  it("does not join two tokens, and refuses a block comment with no end", () => {
    assert.throws(() => JSON.parse(stripComments('{"maxTreeLines":1/*x*/0}')));
    assert.throws(() => JSON.parse(stripComments('{"idPills":tr/*x*/ue}')));
    assert.throws(() => stripComments("{}/* no end"), /has no \*\/ end/);
    assert.equal(parseConfig("{}/* no end").problems.length, 1);
  });
});

describe("isKeyId", () => {
  it("accepts keys that pi can bind, with a modifier other than shift", () => {
    for (const key of ["ctrl+shift+t", "alt+x", "ctrl+alt+super+shift+1", "ctrl+pageDown", "ctrl+/", "super+tab", "f5"]) {
      assert.equal(isKeyId(key), true, key);
    }
  });

  it("refuses keys that pi cannot match, that catch normal input, or that pi needs", () => {
    for (const key of [
      "", "ctrl+", "ctrl+ctrl+t", "meta+t", "ctrl+shift+T", "ctrl+tt", "f13", " t",
      "t", "shift+t", "tab", "shift+pageDown", // normal input
      "ctrl++", "+", // pi splits keys on "+"
      "ctrl+[", "ctrl+]", "ctrl+\\", // the same bytes as Escape and other control keys
      "escape", "ctrl+escape", "esc", // pi stops the agent with Escape
      "ctrl+f5", // pi does not match modifiers on function keys
      "ctrl+m", "ctrl+i", "ctrl+j", "ctrl+h", "ctrl+alt+m", // the same bytes as Enter, Tab, Backspace
    ]) {
      assert.equal(isKeyId(key), false, key);
    }
  });
});

describe("parseConfig", () => {
  it("uses the defaults for an empty object", () => {
    assert.deepEqual(parseConfig("{}"), { config: DEFAULT_CONFIG, problems: [] });
  });

  it("reads all fields (as in the README example, with askTool set)", () => {
    const { config, problems } = parseConfig(`{
      // Key that shows or hides completed and canceled tasks.
      "toggleCompletedKey": "ctrl+shift+y",
      "idPills": false,
      "maxTreeLines": 8,
      "maxParallelSubAgents": 2,
      "maxIdleContinuations": 5,
      // "askTool" is commented out in the README example.
      "askTool": "ask_user_question",
      "taskTypes": {
        "plan":  { "description": "Make or change the task list." },
        "spike": { "description": "Try an idea.", "readOnly": true }
      }
    }`);
    assert.deepEqual(problems, []);
    assert.deepEqual(config, {
      toggleCompletedKey: "ctrl+shift+y",
      idPills: false,
      maxTreeLines: 8,
      maxParallelSubAgents: 2,
      maxIdleContinuations: 5,
      askTool: "ask_user_question",
      taskTypes: {
        plan: { description: "Make or change the task list.", readOnly: false },
        spike: { description: "Try an idea.", readOnly: true },
      },
    });
  });

  it("uses the default of each field that is not valid, and tells why", () => {
    const { config, problems } = parseConfig(
      JSON.stringify({
        toggleCompletedKey: "hyper+t",
        idPills: "yes",
        maxTreeLines: 0,
        maxParallelSubAgents: 2.5,
        maxIdleContinuations: 101,
        colour: "blue",
      }),
    );
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.deepEqual(problems, [
      'toggleCompletedKey must be a key, for example "ctrl+shift+t". tau uses the default value.',
      "idPills must be true or false. tau uses the default value.",
      "maxTreeLines must be an integer from 1 to 100. tau uses the default value.",
      "maxParallelSubAgents must be an integer from 1 to 32. tau uses the default value.",
      "maxIdleContinuations must be an integer from 0 to 100. tau uses the default value.",
      '"colour" is not a configuration field. tau does not use it.',
    ]);
  });

  it("keeps the valid fields when other fields are not valid", () => {
    const { config } = parseConfig(JSON.stringify({ maxTreeLines: 3, idPills: 1 }));
    assert.equal(config.maxTreeLines, 3);
    assert.equal(config.idPills, true);
  });

  it("uses the default task types when a task type is not valid", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /has no task types/],
      [{ plan: { description: "x" }, "Bad Name": { description: "x" } }, /"Bad Name" is not a valid name/],
      [{ plan: { description: "x" }, code: {} }, /code must be an object with a description/],
      [{ plan: { description: "x" }, code: { description: "x", readOnly: "no" } }, /readOnly of the task type code must be true or false/],
      [{ plan: { description: "x" }, code: { description: "   " } }, /description of the task type code must have 1 to 300 characters/],
      [{ plan: { description: "x" }, code: { description: "x", color: "red" } }, /code has fields that tau does not know: "color"/],
      [{ code: { description: "x" } }, /must have the task type "plan"/],
      [Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`t${index}`, { description: "x" }])), /51 task types\. The maximum is 50/],
      [[], /taskTypes must be an object of task types/],
    ];
    for (const [taskTypes, message] of cases) {
      const { config, problems } = parseConfig(JSON.stringify({ taskTypes }));
      assert.deepEqual(config.taskTypes, DEFAULT_CONFIG.taskTypes, JSON.stringify(taskTypes).slice(0, 40));
      assert.ok(problems.some((line) => message.test(line)), `${problems.join(" | ")} ~ ${message}`);
    }
  });

  it("removes control characters from task type descriptions", () => {
    const { config } = parseConfig(JSON.stringify({ taskTypes: { plan: { description: "Plan\u001b[2J it\nnow" } } }));
    assert.equal(config.taskTypes.plan?.description, "Plan it now");
  });

  it("does not stop for field names of the object prototype", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const { config, problems } = parseConfig(`{ "${name}": 1, "maxTreeLines": 3 }`);
      assert.equal(config.maxTreeLines, 3, name);
      assert.deepEqual(problems, [`"${name}" is not a configuration field. tau does not use it.`], name);
    }
  });

  it("shows at most 20 problem lines", () => {
    const { problems } = parseConfig(JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`x${index}`, 1]))));
    assert.equal(problems.length, 21);
    assert.equal(problems.at(-1), "… and 10 more problems.");
  });

  it("removes terminal control characters from the JSON error", () => {
    const { problems } = parseConfig("x\u001b[2J");
    assert.doesNotMatch(problems[0] ?? "", /\u001b/);
  });

  it("keeps the valid fields when the task types are not valid", () => {
    const { config, problems } = parseConfig(JSON.stringify({ maxTreeLines: 3, taskTypes: { code: { description: "x" } } }));
    assert.equal(config.maxTreeLines, 3);
    assert.deepEqual(config.taskTypes, DEFAULT_CONFIG.taskTypes);
    assert.equal(problems.length, 2);
  });

  it("uses the defaults for text that is not a JSON object", () => {
    for (const text of ["", "[1]", "{ bad", "null"]) {
      const { config, problems } = parseConfig(text);
      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.equal(problems.length, 1, text);
    }
  });
});

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tau-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the defaults with no problem when the file does not exist", async () => {
    assert.deepEqual(await loadConfig(dir), { config: DEFAULT_CONFIG, file: join(dir, "config.json"), problems: [] });
  });

  it("reads the file, also through a symbolic link", async () => {
    await writeFile(join(dir, "real.json"), '{ "maxTreeLines": 4 }');
    await symlink(join(dir, "real.json"), join(dir, "config.json"));
    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.maxTreeLines, 4);
    assert.deepEqual(loaded.problems, []);
  });

  it("warns about a symbolic link to a file that does not exist, and a link to a directory", async () => {
    await symlink(join(dir, "missing.json"), join(dir, "config.json"));
    const broken = await loadConfig(dir);
    assert.deepEqual(broken.config, DEFAULT_CONFIG);
    assert.match(broken.problems[0] ?? "", /tau cannot read .*config\.json/);
    await rm(join(dir, "config.json"));
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "config.json"));
    assert.match((await loadConfig(dir)).problems[0] ?? "", /is not a regular file/);
  });

  it("does not wait for a named pipe (FIFO)", { timeout: 5_000 }, async () => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("mkfifo", [join(dir, "config.json")]);
    } catch {
      return; // no mkfifo on this system
    }
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.match(loaded.problems[0] ?? "", /is not a regular file/);
  });

  it("warns about a file that it cannot read", async () => {
    if (process.getuid?.() === 0) return; // root can read all files
    const { chmod } = await import("node:fs/promises");
    await writeFile(join(dir, "config.json"), "{}");
    await chmod(join(dir, "config.json"), 0o000);
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.match(loaded.problems[0] ?? "", /tau cannot read/);
  });

  it("uses the defaults for a directory, or a file that is too large", async () => {
    await mkdir(join(dir, "config.json"));
    assert.match((await loadConfig(dir)).problems[0] ?? "", /is not a regular file/);
    await rm(join(dir, "config.json"), { recursive: true });
    await writeFile(join(dir, "config.json"), `{ "a": "${"x".repeat(MAX_CONFIG_BYTES)}" }`);
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.match(loaded.problems[0] ?? "", /has more than 65536 bytes/);
  });
});

describe("askTool", () => {
  it("is not set by default, and keeps a valid tool name", () => {
    assert.equal(DEFAULT_CONFIG.askTool, undefined);
    assert.equal(parseConfig("{}").config.askTool, undefined);
    for (const name of ["ask_user_question", "AskUser", "ask-user", `a${"b".repeat(63)}`]) {
      const { config, problems } = parseConfig(JSON.stringify({ askTool: name }));
      assert.deepEqual(problems, [], name);
      assert.equal(config.askTool, name);
    }
  });

  it("refuses names that are not valid, tau tools, and built-in tools", () => {
    for (const value of ["", "1ask", "_ask", "ask user", "ask\u001b[31m", `a${"b".repeat(64)}`, "tau_ask_user", "tau_list", "bash", "edit", "write", "read", 3, null, true]) {
      const { config, problems } = parseConfig(JSON.stringify({ askTool: value }));
      assert.equal(config.askTool, undefined, JSON.stringify(value));
      assert.equal(problems.length, 1, JSON.stringify(value));
      assert.match(problems[0]!, /^askTool must be the name of an "ask question" tool of a different extension/);
    }
  });

  it("goes to sub-agents in TAU_CONFIG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-config-"));
    try {
      const inherited = await configFor({ TAU_TASKLIST: "/x.db", TAU_CONFIG: JSON.stringify({ ...DEFAULT_CONFIG, askTool: "ask_user_question" }) }, dir);
      assert.equal(inherited.config.askTool, "ask_user_question");
      assert.equal(inherited.fatal, undefined);
      // Without the field, a sub-agent has no ask tool of the configuration.
      assert.equal((await configFor({ TAU_TASKLIST: "/x.db", TAU_CONFIG: JSON.stringify(DEFAULT_CONFIG) }, dir)).config.askTool, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("configFor", () => {
  it("uses the configuration of the lead (TAU_CONFIG) in a sub-agent, not the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-config-"));
    try {
      await writeFile(join(dir, "config.json"), '{ "maxTreeLines": 9 }');
      const sub = { TAU_TASKLIST: "/x.db" };
      const inherited = await configFor({ ...sub, TAU_CONFIG: JSON.stringify({ ...DEFAULT_CONFIG, maxTreeLines: 2 }) }, dir);
      assert.equal(inherited.config.maxTreeLines, 2);
      assert.deepEqual(inherited.problems, []);
      assert.equal(inherited.fatal, undefined);
      // A lead reads its file, also with a TAU_CONFIG in its environment.
      assert.equal((await configFor({ TAU_CONFIG: '{"maxTreeLines":2}' }, dir)).config.maxTreeLines, 9);
      // A sub-agent without a valid inherited configuration cannot start.
      for (const value of [undefined, "", "{ bad", '{"maxTreeLines":0}']) {
        const env = value === undefined ? sub : { ...sub, TAU_CONFIG: value };
        assert.match((await configFor(env, dir)).fatal ?? "", /did not get a valid configuration from its lead/, String(value));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
