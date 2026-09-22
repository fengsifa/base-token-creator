import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_BYTES = 2_000_000;

/**
 * Logos are written to public/ and therefore served from this app's own origin.
 * Only raster formats are accepted: an uploaded SVG would be executable content
 * on the same origin and is a stored-XSS vector, so it is rejected outright.
 */
const ALLOWED_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No logo file provided." }, { status: 400 });
    }

    if (file.size === 0) {
      return NextResponse.json({ error: "The uploaded logo is empty." }, { status: 400 });
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Logo must be an image under 2MB." }, { status: 400 });
    }

    const extension = ALLOWED_TYPES[file.type];
    if (!extension) {
      return NextResponse.json(
        { error: "Logo must be a PNG, JPEG, WebP or GIF image." },
        { status: 400 },
      );
    }

    // The stored name is generated, never taken from the client, so a crafted
    // filename cannot escape the uploads directory.
    const fileName = `${crypto.randomUUID()}${extension}`;
    const directory = path.join(process.cwd(), "public", "uploads");

    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, fileName), Buffer.from(await file.arrayBuffer()));

    return NextResponse.json({ logo_url: `/uploads/${fileName}` });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 503 },
    );
  }
}
