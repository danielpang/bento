import { Box, Text } from "ink";

/**
 * Shown once when agents run on this machine against a shared server.
 *
 * The board itself is tracked normally: teammates see the cards, run
 * status, and transcripts. What stays here is the work product, so this
 * spells out the three consequences people are surprised by.
 */
export function RunnerNotice({ server, sandbox }: { server: string; sandbox: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text color="yellow">Agents run on this machine</Text>
      <Text color="gray">
        {server} tracks the board, so your team sees cards, run status, and transcripts. These stay local:
      </Text>
      <Text color="gray">- Code the agents write lands in checkouts here and is not pushed for you</Text>
      <Text color="gray">- Your repository paths and agent API keys never reach the server</Text>
      <Text color="gray">- Runs queued for this machine wait until it is online again</Text>
      <Text color="gray">Sandboxes: {sandbox}. Push a branch or open a pull request to share the work.</Text>
    </Box>
  );
}
