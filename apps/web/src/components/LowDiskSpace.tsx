import { useEffect, useState } from "react";

const POLL_MS = 5 * 60_000;

/**
 * Local mode only: the route 404s on a shared server, and this renders
 * nothing. A full disk stops Docker and stalls every agent without an
 * error anywhere else, so it is said before it happens.
 */
export function LowDiskSpace() {
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void fetch("/api/settings/disk-space", { credentials: "include" })
        .then(async (res) => {
          if (res.status === 404) {
            stopped = true;
            return;
          }
          if (!res.ok) return;
          const body = (await res.json()) as { warning: string | null };
          setWarning(body.warning);
        })
        .catch(() => {})
        .finally(() => {
          if (!stopped) timer = setTimeout(load, POLL_MS);
        });
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  if (!warning) return null;
  return (
    <div className="setup-prompt" role="alert">
      <span>{warning}</span>
    </div>
  );
}
