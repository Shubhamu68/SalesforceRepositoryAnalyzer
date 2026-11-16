export function maskSoql(text: string): string {
  const out = text.split("");
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  const blank = (i: number) => { if (text[i] !== "\n" && text[i] !== "\r") out[i] = " "; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (state === "normal") {
      if (ch === "'") { state = "single"; blank(i); }
      else if (ch === '"') { state = "double"; blank(i); }
      else if ((ch === "/" && next === "/") || (ch === "-" && next === "-")) { state = "line"; blank(i); blank(++i); }
      else if (ch === "/" && next === "*") { state = "block"; blank(i); blank(++i); }
    } else if (state === "line") {
      if (ch === "\n") state = "normal"; else blank(i);
    } else if (state === "block") {
      if (ch === "*" && next === "/") { blank(i); blank(++i); state = "normal"; }
      else blank(i);
    } else {
      if (ch === "\\" && next !== undefined) { blank(i); blank(++i); }
      else if ((state === "single" && ch === "'") || (state === "double" && ch === '"')) { blank(i); state = "normal"; }
      else blank(i);
    }
  }
  return out.join("");
}
