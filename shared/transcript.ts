export type TranscriptSentence = {
  id: number;
  text: string;
};

export type TranscriptState = {
  finalSentences: TranscriptSentence[];
  interimSentence: TranscriptSentence | null;
};

export type TranscriptUpdate = TranscriptSentence & {
  final: boolean;
};

export const emptyTranscript: TranscriptState = {
  finalSentences: [],
  interimSentence: null,
};

export function applyTranscriptUpdate(
  state: TranscriptState,
  update: TranscriptUpdate,
): TranscriptState {
  const text = update.text.trim();
  if (!Number.isInteger(update.id) || update.id < 1) {
    return state;
  }

  const existingIndex = state.finalSentences.findIndex(
    (sentence) => sentence.id === update.id,
  );

  if (!update.final) {
    if (existingIndex >= 0) {
      return state;
    }

    return {
      ...state,
      interimSentence: { id: update.id, text },
    };
  }

  const finalSentences = [...state.finalSentences];
  if (existingIndex >= 0) {
    finalSentences[existingIndex] = { id: update.id, text };
  } else if (text) {
    finalSentences.push({ id: update.id, text });
    finalSentences.sort((left, right) => left.id - right.id);
  }

  return {
    finalSentences,
    interimSentence:
      state.interimSentence?.id === update.id ? null : state.interimSentence,
  };
}

export function getFinalTranscript(state: TranscriptState) {
  return state.finalSentences
    .map((sentence) => sentence.text)
    .filter(Boolean)
    .join("\n");
}
