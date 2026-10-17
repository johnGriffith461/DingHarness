import assert from "node:assert/strict";

import { parse } from "./args.js";

assert.deepEqual(parse(["--name", "阿洁"]), { name: "阿洁" });
assert.deepEqual(parse([]), { name: "" });
console.log("ok");
