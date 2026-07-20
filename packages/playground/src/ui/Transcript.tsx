/**
 * One transcript entry. Rendered inside <Static>, so each is painted once and
 * then owned by the terminal's own scrollback — the same reason Claude Code's
 * history scrolls like a normal shell instead of repainting a viewport.
 */
import React from "react";
import { Box, Text } from "ink";
import { bodyLines, formatArgs, ms, toolSummary, type Item } from "./items.js";

const PREVIEW = 4;

export function Entry({ item }: { item: Item }) {
  switch (item.kind) {
    case "banner":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color="magenta">✻</Text> <Text bold>Veil playground</Text>
          </Text>
          <Text color="gray"> {item.model} · veil over MCP · {item.tools.join(", ")}</Text>
          <Text color="gray"> trace → {item.trace}</Text>
        </Box>
      );
    case "user":
      return (
        <Box marginY={1}>
          <Text color="gray">&gt; </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginBottom={1}>
          <Text color="magenta">● </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "note":
      return (
        <Box marginBottom={1}>
          <Text color="yellow">● </Text>
          <Text color="yellow">{item.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginBottom={1}>
          <Text color="red">● </Text>
          <Text color="red">{item.text}</Text>
        </Box>
      );
    case "tool": {
      const preview = bodyLines(item).slice(0, PREVIEW);
      const hidden = bodyLines(item).length - preview.length;
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={item.ok ? "green" : "red"}>● </Text>
            <Text bold>{item.name}</Text>
            <Text color="gray">({formatArgs(item.args)})</Text>
          </Text>
          <Box>
            <Text color="gray"> ⎿ </Text>
            <Text color={item.ok ? "gray" : "red"}>
              {toolSummary(item)}
              <Text color="gray"> · {ms(item.ms)}</Text>
            </Text>
          </Box>
          {preview.length > 0 && (
            <Box flexDirection="column" marginLeft={5}>
              {preview.map((l, i) => (
                <Text key={i} color="gray" dimColor>
                  {l.length > 96 ? l.slice(0, 95) + "…" : l}
                </Text>
              ))}
              {hidden > 0 && (
                <Text color="gray" dimColor>
                  … +{hidden} more lines
                </Text>
              )}
            </Box>
          )}
        </Box>
      );
    }
  }
}
