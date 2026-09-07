import { Box, Text } from "ink";
import { useMouseTarget } from "../mouse.js";

export function MouseButton({
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const ref = useMouseTarget({ onClick, priority: 3 }, !disabled);
  return (
    <Box ref={ref} aria-role="button" aria-state={{ disabled }}>
      <Text color={disabled ? "gray" : danger ? "red" : "cyan"}>[{label}]</Text>
    </Box>
  );
}

export function MouseActions({ children }: { children: React.ReactNode }) {
  return (
    <Box gap={1} flexWrap="wrap">
      {children}
    </Box>
  );
}
