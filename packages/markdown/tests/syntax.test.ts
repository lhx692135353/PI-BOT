import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { containsMath, mathAt } from "../src/syntax.js";
test("shared math routing fixtures cover native clients, code, amounts, escapes and incomplete streams",()=>{
  const fixtures=JSON.parse(readFileSync(new URL("../fixtures/routing.json",import.meta.url),"utf8"));
  for(const fixture of fixtures)assert.equal(containsMath(fixture.source),fixture.math,fixture.source);
});
test("math tokens protect TeX from Markdown and retain source delimiters",()=>{
  assert.deepEqual(mathAt("$t_3$",0),{start:0,end:5,tex:"t_3",display:false,raw:"$t_3$"});
  assert.equal(mathAt("\\[x\n+y\\]",0)?.display,true);
  assert.equal(mathAt("$unfinished",0),null);
  assert.equal(mathAt("$x\ny$",0),null);
  assert.equal(mathAt("$5 and $10",0),null);
  assert.equal(mathAt("\\$escaped$",1),null);
});
