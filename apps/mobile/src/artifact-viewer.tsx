import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import { useQuery } from '@tanstack/react-query';
import type { RunArtifact } from '@bento/api-client';
import { useSession } from './session';
import { fonts, radius, usePalette, type Palette } from './theme';
import { ErrorMessage, Loading, T } from './ui';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_LIMIT = 10 * 1024 * 1024;

/**
 * Renders one artifact. Agent output is untrusted: markdown renders without
 * raw HTML, and HTML or diagrams run only inside a web view that has no
 * bridge to the app, no cookies, and cannot navigate the top frame.
 */
export function ArtifactView({ artifact }: { artifact: RunArtifact }) {
  const { client } = useSession();
  const [source, setSource] = useState(false);
  const textual = artifact.kind === 'markdown' || artifact.kind === 'mermaid' || artifact.kind === 'html' || (artifact.kind === 'file' && artifact.mime.startsWith('text/'));
  const text = useQuery({ queryKey: ['artifact-text', artifact.id], queryFn: () => client.getArtifactText(artifact.id), enabled: textual, staleTime: Infinity });
  const image = useQuery({
    queryKey: ['artifact-image', artifact.id],
    queryFn: async () => `data:${artifact.mime};base64,${toBase64(await client.getArtifactBytes(artifact.id, { maxBytes: IMAGE_LIMIT }))}`,
    enabled: artifact.kind === 'image' && IMAGE_MIMES.has(artifact.mime),
    staleTime: Infinity,
  });
  const canToggle = artifact.kind === 'html' || artifact.kind === 'mermaid';

  let body: React.ReactNode;
  if (text.error || image.error) body = <ErrorMessage error="Could not load this artifact. Check the connection and open it again." />;
  else if (artifact.kind === 'image') body = !IMAGE_MIMES.has(artifact.mime) ? <NoPreview /> : image.data ? <ImagePreview uri={image.data} /> : <Loading />;
  else if (!textual) body = <NoPreview />;
  else if (text.data === undefined) body = <Loading />;
  else if (source || artifact.kind === 'file') body = <Source text={text.data} />;
  else if (artifact.kind === 'markdown') body = <MarkdownView text={text.data} />;
  else if (artifact.kind === 'mermaid') body = <Sandboxed html={mermaidPage(text.data)} />;
  else body = <Sandboxed html={text.data} />;

  return <View style={{ flex: 1, gap: 10 }}>
    {canToggle && text.data !== undefined && <Pressable accessibilityRole="button" onPress={() => setSource(on => !on)} style={{ alignSelf: 'flex-end' }} hitSlop={8}>
      <ToggleLabel on={source} />
    </Pressable>}
    {body}
  </View>;
}

function ToggleLabel({ on }: { on: boolean }) {
  const p = usePalette();
  return <T style={{ color: p.textDim, fontFamily: fonts.medium, fontSize: 14 }}>{on ? 'Preview' : 'View source'}</T>;
}

/** A tile's image preview, fetched with the bearer token and shown only for raster types. */
export function ImageThumb({ artifactId, fallback }: { artifactId: string; fallback: React.ReactNode }) {
  const { client } = useSession();
  const thumb = useQuery({
    queryKey: ['artifact-thumb', artifactId],
    queryFn: async () => {
      const meta = await client.getArtifact(artifactId);
      if (!IMAGE_MIMES.has(meta.mime)) return null;
      return `data:${meta.mime};base64,${toBase64(await client.getArtifactBytes(artifactId, { maxBytes: 2 * 1024 * 1024 }))}`;
    },
    staleTime: Infinity,
  });
  if (!thumb.data) return <>{fallback}</>;
  return <Image source={{ uri: thumb.data }} style={{ flex: 1, borderRadius: radius }} resizeMode="cover" accessibilityIgnoresInvertColors />;
}

function NoPreview() {
  return <T variant="dim">This file has no preview here. Open it in Bento on the web to download it.</T>;
}

function ImagePreview({ uri }: { uri: string }) {
  const [ratio, setRatio] = useState(4 / 3);
  return <ScrollView maximumZoomScale={4} minimumZoomScale={1} centerContent>
    <Image
      source={{ uri }}
      onLoad={event => { const { width, height } = event.nativeEvent.source; if (width && height) setRatio(width / height); }}
      style={{ width: '100%', aspectRatio: ratio, borderRadius: radius }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
    />
  </ScrollView>;
}

function Source({ text }: { text: string }) {
  const p = usePalette();
  return <ScrollView horizontal style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius + 1, backgroundColor: p.bg }}>
    <T selectable style={{ color: p.text, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, padding: 12 }}>{text}</T>
  </ScrollView>;
}

export function MarkdownView({ text, compact }: { text: string; compact?: boolean }) {
  const p = usePalette();
  const style = useMemo(() => markdownStyles(p, compact), [p, compact]);
  // Agent markdown never loads remote images: a URL the agent chose would learn the viewer's address.
  const rules = useMemo(() => ({
    image: (node: { key: string; attributes?: { alt?: string } }) => <Text key={node.key} style={{ color: p.textFaint, fontFamily: fonts.regular }}>[{node.attributes?.alt || 'image'}]</Text>,
  }), [p]);
  return <Markdown style={style} rules={rules} onLinkPress={url => { if (/^https:\/\//i.test(url)) void WebBrowser.openBrowserAsync(url); return false; }}>{text}</Markdown>;
}

function markdownStyles(p: Palette, compact?: boolean) {
  const scale = compact ? 0.92 : 1;
  return {
    body: { color: p.text, fontFamily: fonts.regular, fontSize: 15 * scale, lineHeight: 23 * scale },
    heading1: { color: p.text, fontFamily: fonts.semibold, fontSize: 22 * scale, lineHeight: 28 * scale, marginTop: 4, marginBottom: 8 },
    heading2: { color: p.text, fontFamily: fonts.semibold, fontSize: 18 * scale, lineHeight: 24 * scale, marginTop: 14, marginBottom: 6 },
    heading3: { color: p.text, fontFamily: fonts.semibold, fontSize: 16 * scale, marginTop: 12, marginBottom: 4 },
    strong: { fontFamily: fonts.semibold },
    link: { color: p.brand, textDecorationLine: 'underline' as const },
    bullet_list_icon: { color: p.textDim },
    ordered_list_icon: { color: p.textDim },
    code_inline: { fontFamily: fonts.mono, fontSize: 13 * scale, backgroundColor: p.panelRaised, color: p.text, borderRadius: 4, paddingHorizontal: 4 },
    code_block: { fontFamily: fonts.mono, fontSize: 12.5 * scale, backgroundColor: p.bg, color: p.text, borderColor: p.line, borderWidth: 1, borderRadius: radius, padding: 10 },
    fence: { fontFamily: fonts.mono, fontSize: 12.5 * scale, backgroundColor: p.bg, color: p.text, borderColor: p.line, borderWidth: 1, borderRadius: radius, padding: 10 },
    blockquote: { backgroundColor: 'transparent', borderLeftColor: p.lineBright, borderLeftWidth: 3, paddingLeft: 10, marginLeft: 0 },
    hr: { backgroundColor: p.line, height: 1 },
    table: { borderColor: p.line, borderRadius: radius },
    th: { padding: 6, borderColor: p.line },
    td: { padding: 6, borderColor: p.line },
    tr: { borderColor: p.line },
  };
}

/** A web view with no bridge, no shared cookies, and no way to leave the page it was given. */
function Sandboxed({ html }: { html: string }) {
  const p = usePalette();
  const [loaded, setLoaded] = useState(false);
  return <View style={{ flex: 1, minHeight: 420, borderWidth: 1, borderColor: p.line, borderRadius: radius + 1, overflow: 'hidden', backgroundColor: '#ffffff' }}>
    <WebView
      source={{ html, baseUrl: 'about:blank' }}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={(request: WebViewNavigation & { isTopFrame?: boolean }) => request.url === 'about:blank' || request.url.startsWith('about:srcdoc') || request.isTopFrame === false}
      javaScriptEnabled
      javaScriptCanOpenWindowsAutomatically={false}
      incognito
      sharedCookiesEnabled={false}
      allowsLinkPreview={false}
      allowFileAccess={false}
      allowsBackForwardNavigationGestures={false}
      dataDetectorTypes="none"
      onLoadEnd={() => setLoaded(true)}
      style={{ flex: 1, backgroundColor: 'transparent' }}
    />
    {!loaded && <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: p.panel }}><Loading /></View>}
  </View>;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mermaidPage(source: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/mermaid@11.4.1/; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>body{margin:0;padding:16px;background:#ffffff;font-family:-apple-system,sans-serif}</style></head>
<body><pre class="mermaid">${escapeHtml(source)}</pre>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js" integrity="sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I" crossorigin="anonymous"></script>
<script>mermaid.initialize({ startOnLoad: true, securityLevel: 'strict', theme: 'default' });</script>
</body></html>`;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}
