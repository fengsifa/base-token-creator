import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No logo file provided." }, { status: 400 });
    if (file.size > 2_000_000 || !file.type.startsWith("image/")) return NextResponse.json({ error: "Logo must be an image under 2MB." }, { status: 400 });
    const extension = path.extname(file.name).toLowerCase().replace(/[^a-z0-9.]/g, "") || ".img";
    const fileName = `${crypto.randomUUID()}${extension}`;
    const directory = path.join(process.cwd(), "public", "uploads");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, fileName), Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ logo_url: `/uploads/${fileName}` });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Upload failed" }, { status: 503 }); }
}

