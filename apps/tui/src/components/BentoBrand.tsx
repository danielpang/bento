import { Box, Text } from "ink";

const WORDMARK = [
  "██████╗ ███████╗███╗   ██╗████████╗ ██████╗ ",
  "██╔══██╗██╔════╝████╗  ██║╚══██╔══╝██╔═══██╗",
  "██████╔╝█████╗  ██╔██╗ ██║   ██║   ██║   ██║",
  "██╔══██╗██╔══╝  ██║╚██╗██║   ██║   ██║   ██║",
  "██████╔╝███████╗██║ ╚████║   ██║   ╚██████╔╝",
  "╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝ ",
].join("\n");

/** The same uneven compartments and accent colors as the web app's brand mark. */
function BentoMark() {
  return (
    <Box flexDirection="column" width={14} flexShrink={0}>
      <Text color="gray">╭────────────╮</Text>
      {[0, 1, 2].map((row) => (
        <Text key={row} color="gray">
          {"│ "}
          <Text color="#F97316">██████</Text> <Text>███</Text>
          {" │"}
        </Text>
      ))}
      <Text color="gray">{"│            │"}</Text>
      <Text color="gray">
        {"│ ███ "}
        <Text color="#3E77E8">██████</Text>
        {" │"}
      </Text>
      <Text color="gray">╰────────────╯</Text>
    </Box>
  );
}

/** Artwork for the loading screen. */
export function BentoBrand() {
  return (
    <Box gap={3} alignItems="center" flexShrink={0}>
      <BentoMark />
      <Box flexDirection="column">
        <Text>{WORDMARK}</Text>
      </Box>
    </Box>
  );
}
