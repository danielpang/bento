import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders agent-written markdown: stage write-ups and report artifacts.
 *
 * Everything that reaches this component was written by an agent, and
 * agents ingest untrusted input, so raw HTML never renders: react-markdown
 * drops it by default and that default is the point of using it. Links
 * open away from the console, and a ```mermaid fence becomes a drawn
 * diagram, which is how agents naturally write flow charts.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          code: (props) => {
            const { children, className } = props;
            const language = /language-(\w+)/.exec(className ?? "")?.[1];
            if (language === "mermaid") return <MermaidDiagram source={String(children)} />;
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** mermaid.render needs a document-unique element id per call. */
let mermaidSeq = 0;

/**
 * A Mermaid source drawn to SVG, or shown as its source when it does
 * not parse: an agent's almost-right diagram is still worth reading.
 *
 * The library is ~1.5 MB, so it loads on first diagram, not with the
 * app. securityLevel "strict" keeps script and clicks out of the SVG;
 * the drawing sits on its own light surface so the same render reads
 * in either console theme.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const [state, setState] = useState<{ svg?: string; failed?: boolean }>({});

  useEffect(() => {
    let cancelled = false;
    setState({});
    void (async () => {
      try {
        const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([
          import("mermaid"),
          import("dompurify"),
        ]);
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          // Labels as SVG text, not foreignObject HTML: the sanitizer
          // below strips foreignObject (it can smuggle markup), and
          // with HTML labels on, every flowchart node came out blank.
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        });
        mermaidSeq += 1;
        const { svg } = await mermaid.render(`bento-mermaid-${mermaidSeq}`, source);
        // Mermaid sanitizes in strict mode; sanitize its output anyway,
        // so a renderer bug is not a console compromise. The html
        // profile stays on because labels live in foreignObject.
        const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } });
        if (!cancelled) setState({ svg: clean });
      } catch {
        if (!cancelled) setState({ failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (state.failed) return <pre className="artifact">{source}</pre>;
  if (!state.svg) return <p className="muted">Drawing the diagram...</p>;
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: state.svg }} />;
}
