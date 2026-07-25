/**
 * The prompt line.
 *
 * Replaces `ink-text-input`, which loses pasted text. That component derives the
 * next value from its `value` PROP and hands the finished string to `onChange`:
 *
 *     onChange(originalValue.slice(0, cursor) + input + originalValue.slice(cursor))
 *
 * A large paste reaches the TTY as SEVERAL data events. When two land before
 * React re-renders, the second still sees the pre-paste prop, rebuilds from it,
 * and the first chunk is gone. Measured: a 3.5KB, 60-line prompt arrived with
 * whole contiguous blocks missing — an agent ran steps 4-7 and 13-16 of a
 * 16-step script and never saw 1-3 or 8-12, which read as the model disobeying.
 *
 * Two rules fix it:
 *   - every edit is a FUNCTIONAL update, so concurrent chunks compose instead of
 *     clobbering each other;
 *   - only a BARE Return submits. A pasted chunk that merely contains a newline
 *     is text. (Ink already reports `key.return === false` for such a chunk, so
 *     this is belt and braces — but the failure mode it guards against is a
 *     prompt cut in half at its first line break.)
 *
 * Newlines are kept in the value and collapsed only for DISPLAY: rendering a
 * multi-line string in a one-line box breaks Ink's frame-height maths, so stale
 * frames never get cleared and the screen fills with overwritten text.
 */
import React, { useRef, useState } from "react";
import { Text, useInput } from "ink";

export interface InputState {
  value: string;
  cursor: number;
}

/** The subset of Ink's key flags this cares about. */
export interface KeyLike {
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
}

export interface KeyResult {
  state: InputState;
  /** Set when this keystroke completed a turn. */
  submit?: string;
}

export const EMPTY: InputState = { value: "", cursor: 0 };

/**
 * Pure so it can be tested without a terminal — the paste race is invisible to
 * any test that has to drive a real TTY.
 */
export function applyKey(s: InputState, input: string, key: KeyLike): KeyResult {
  // A BARE return submits. A paste carrying newlines is content, not a submit.
  if (key.return && input.length <= 1) {
    return { state: EMPTY, submit: s.value };
  }
  if (key.ctrl && input === "u") return { state: EMPTY };
  if (key.backspace || key.delete) {
    if (s.cursor === 0) return { state: s };
    return {
      state: { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 },
    };
  }
  if (key.leftArrow) return { state: { ...s, cursor: Math.max(0, s.cursor - 1) } };
  if (key.rightArrow) return { state: { ...s, cursor: Math.min(s.value.length, s.cursor + 1) } };
  if (!input) return { state: s };

  // Printable, or a whole pasted block. CR and CRLF become LF so a pasted
  // prompt keeps its line structure instead of turning into stray returns.
  const text = input.replace(/\r\n?/g, "\n");
  return {
    state: {
      value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor),
      cursor: s.cursor + text.length,
    },
  };
}

/** One line, with newlines shown as ⏎ — see the header on why they cannot render. */
export function displayOf(value: string, max = 96): string {
  const flat = value.replace(/\n/g, "⏎ ");
  return flat.length > max ? `…${flat.slice(flat.length - max + 1)}` : flat;
}

export function PromptInput({
  isActive,
  onSubmit,
}: {
  isActive: boolean;
  onSubmit: (text: string) => void;
}) {
  // The ref is the source of truth: it updates SYNCHRONOUSLY, so two paste
  // chunks arriving in one tick compose. State exists only to trigger a repaint.
  // Deriving the next value from a state variable is precisely the bug this
  // component was written to remove.
  const ref = useRef<InputState>(EMPTY);
  const [, repaint] = useState(0);

  useInput(
    (input, key) => {
      const { state, submit } = applyKey(ref.current, input, key);
      ref.current = state;
      repaint((n) => n + 1);
      if (submit !== undefined && submit.trim().length > 0) onSubmit(submit);
    },
    { isActive },
  );

  const { value } = ref.current;
  return (
    <Text>
      {displayOf(value)}
      <Text inverse> </Text>
      {value.length > 0 && <Text color="gray" dimColor>{`  (${value.length} chars)`}</Text>}
    </Text>
  );
}
