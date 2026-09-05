import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureException } from "./posthog.js";

/**
 * Last stop for a render that threw. The existing panels already catch
 * their own fetch failures and toast them; this is for the ones that
 * escape, which would otherwise blank the whole console.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureException(error, {
      source: "react_error_boundary",
      ...(info.componentStack ? { component_stack: info.componentStack } : {}),
    });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center">
        <div className="unreachable">
          <p>Something went wrong.</p>
          <p className="muted">{this.state.error.message}</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
