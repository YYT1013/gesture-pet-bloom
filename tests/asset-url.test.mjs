import assert from "node:assert/strict";
import test from "node:test";

import { asDirectoryUrl } from "../js/asset-url.js";

test("asDirectoryUrl keeps Vite-transformed directory URLs joinable", () => {
  assert.equal(asDirectoryUrl("http://localhost:4173/assets/scene"), "http://localhost:4173/assets/scene/");
  assert.equal(asDirectoryUrl("http://localhost:4173/assets/scene/"), "http://localhost:4173/assets/scene/");
});

test("asDirectoryUrl handles filesystem-base URLs used by Vite dev", () => {
  assert.equal(
    asDirectoryUrl("http://localhost:4173/@fs/D:/projects/pet"),
    "http://localhost:4173/@fs/D:/projects/pet/",
  );
});
