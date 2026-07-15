/**
 * The tool-use permission prompt — the step gate, in Claude Code's idiom.
 *
 * A numbered choice rather than a bare keypress, because "yes, and don't ask
 * again for this tool" is the option that actually makes a long debugging
 * session bearable: gate the interesting calls, wave through veil_graph.
 */
import React from "react";
import { Box, Text } from "ink";
import { formatArgs } from "./items.js";

export interface Choice {
  label: string;
  value: "go" | "always" | "abort";
}

export const CHOICES: Choice[] = [
  { label: "Yes", value: "go" },
  { label: "Yes, and don't ask again for this tool", value: "always" },
  { label: "No, tell the model what to do differently", value: "abort" },
];

export function Permission({
  name,
  args,
  cursor,
}: {
  name: string;
  args: unknown;
  cursor: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Tool use
      </Text>
      <Box marginTop={1}>
        <Text>
          <Text bold>{name}</Text>
          <Text color="gray">({formatArgs(args)})</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      {CHOICES.map((c, i) => (
        <Text key={c.value} color={i === cursor ? "cyan" : undefined}>
          {i === cursor ? "❯" : " "} {i + 1}. {c.label}
        </Text>
      ))}
    </Box>
  );
}
