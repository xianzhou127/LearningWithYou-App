import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTranscriptUpdate,
  emptyTranscript,
  getFinalTranscript,
} from "../shared/transcript";

test("中间结果替换当前句，最终结果只追加一次", () => {
  let state = applyTranscriptUpdate(emptyTranscript, {
    id: 1,
    text: "这是中间",
    final: false,
  });
  state = applyTranscriptUpdate(state, {
    id: 1,
    text: "这是更新后的中间结果",
    final: false,
  });

  assert.equal(state.interimSentence?.text, "这是更新后的中间结果");

  state = applyTranscriptUpdate(state, {
    id: 1,
    text: "这是第一句。",
    final: true,
  });
  state = applyTranscriptUpdate(state, {
    id: 1,
    text: "这是第一句。",
    final: true,
  });
  state = applyTranscriptUpdate(state, {
    id: 2,
    text: "这是第二句。",
    final: true,
  });

  assert.equal(state.interimSentence, null);
  assert.equal(state.finalSentences.length, 2);
  assert.equal(getFinalTranscript(state), "这是第一句。\n这是第二句。");
});

test("已经完成的句子不会被迟到的中间结果覆盖", () => {
  let state = applyTranscriptUpdate(emptyTranscript, {
    id: 3,
    text: "最终句。",
    final: true,
  });
  state = applyTranscriptUpdate(state, {
    id: 3,
    text: "迟到的中间句",
    final: false,
  });

  assert.equal(getFinalTranscript(state), "最终句。");
  assert.equal(state.interimSentence, null);
});
