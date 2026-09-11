import { execFile } from "node:child_process";

export interface ClipboardContent {
  text?: string;
  files?: string[];
  image?: { name: string; mime: string; data: string };
}
function command(binary: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { encoding: "buffer", maxBuffer: 12 * 1024 * 1024, timeout: 8000 },
      (error, stdout) =>
        error
          ? reject(
              new Error("Clipboard unavailable. Use your terminal's paste shortcut or paste a file path."),
            )
          : resolve(stdout),
    );
    child.stdin?.end(input);
  });
}

// Only read on an explicit paste action. Never poll the user's clipboard.
export async function readClipboard(pasteboardName?: string): Promise<ClipboardContent> {
  if (process.platform === "darwin") {
    const script = `ObjC.import('AppKit');
const pb = ${pasteboardName ? `$.NSPasteboard.pasteboardWithName(${JSON.stringify(pasteboardName)})` : "$.NSPasteboard.generalPasteboard"};
const paths = pb.propertyListForType('NSFilenamesPboardType');
let result;
if (paths && !paths.isNil()) result = {files: ObjC.deepUnwrap(paths)};
if (!result) {
 const files=[]; const items=pb.pasteboardItems;
 if(items && !items.isNil()) for(let i=0;i<items.count;i++) {
  const url=items.objectAtIndex(i).stringForType('public.file-url');
  if(url && !url.isNil()) files.push(ObjC.unwrap($.NSURL.URLWithString(url).path));
 }
 if(files.length) result={files};
}
if (!result) {
 let png=pb.dataForType('public.png');
 if(!png || png.isNil()) { const tiff=pb.dataForType('public.tiff'); if(tiff && !tiff.isNil()) png=$.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSPNGFileType,{}); }
 if(png && !png.isNil()) result={image:{name:'clipboard.png',mime:'image/png',data:ObjC.unwrap(png.base64EncodedStringWithOptions(0))}};
}
if(!result) {const text=pb.stringForType('public.utf8-plain-text');result={text:text && !text.isNil()?ObjC.unwrap(text):''};}
JSON.stringify(result);`;
    return JSON.parse((await command("osascript", ["-l", "JavaScript", "-e", script])).toString("utf8"));
  }
  if (process.platform === "win32") {
    return {
      text: (await command("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]))
        .toString("utf8")
        .replace(/\r\n$/, ""),
    };
  }
  for (const [binary, prefix] of [
    ["wl-paste", []],
    ["xclip", ["-selection", "clipboard", "-o"]],
  ] as const) {
    try {
      const bytes = await command(binary, [...prefix, binary === "wl-paste" ? "--type" : "-t", "image/png"]);
      if (bytes.length)
        return { image: { name: "clipboard.png", mime: "image/png", data: bytes.toString("base64") } };
    } catch {
      /* Try plain text or the next clipboard provider. */
    }
    try {
      return {
        text: (
          await command(binary, [...prefix, ...(binary === "wl-paste" ? ["--no-newline"] : [])])
        ).toString("utf8"),
      };
    } catch {
      /* Try the next provider. */
    }
  }
  throw new Error("Clipboard unavailable. Use your terminal's paste shortcut or install wl-clipboard/xclip.");
}

export async function copyToClipboard(text: string): Promise<void> {
  if (process.platform === "darwin") {
    await command("pbcopy", [], text).catch(() => {
      throw new Error("Could not copy to the clipboard. Check that pbcopy is available.");
    });
    return;
  }
  if (process.platform === "win32") {
    await command("clip.exe", [], text).catch(() => {
      throw new Error("Could not copy to the clipboard. Check that clip.exe is available.");
    });
    return;
  }
  for (const [binary, args] of [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
  ] as const) {
    try {
      await command(binary, [...args], text);
      return;
    } catch {
      /* Try the next provider. */
    }
  }
  throw new Error("Could not copy. Install wl-clipboard or xclip for clipboard access.");
}
