import { Box, Text, useIsScreenReaderEnabled, useStdout, useWindowSize } from "ink";
import { terminalText } from "../terminal.js";
import { BentoBrand } from "./BentoBrand.js";

/** Startup status stays live; the artwork never holds up a ready board. */
export function Startup({ message }: { message: string }) {
  const { columns, rows } = useWindowSize();
  const { stdout } = useStdout();
  const screenReader = useIsScreenReaderEnabled();
  const status = terminalText(message).replace(/\s+/g, " ").trim();

  // Decorative glyphs are noise to a screen reader and to redirected output.
  if (screenReader || !stdout.isTTY || process.env.TERM === "dumb") {
    return <Text>Bento: {status}</Text>;
  }

  const full = columns >= 66 && rows >= 13;
  return (
    <Box
      width={columns}
      height={rows}
      paddingX={columns > 4 ? 1 : 0}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
    >
      {full ? (
        <BentoBrand />
      ) : (
        <Text bold color="#F97316">
          bento
        </Text>
      )}
      {rows >= 6 && columns >= 20 && (
        <Box marginTop={1} flexShrink={0}>
          <Text dimColor>Kanban for agents</Text>
        </Box>
      )}
      {rows >= 3 && (
        <Box marginTop={rows >= 11 ? 1 : 0} width="100%" justifyContent="center" flexShrink={0}>
          <Text color="gray" wrap="truncate-end">
            {status}
          </Text>
        </Box>
      )}
    </Box>
  );
}
