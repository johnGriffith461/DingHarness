import assert from "node:assert/strict";

import { doubled } from "./use.js";

assert.equal(doubled, 42);
console.log("ok");
