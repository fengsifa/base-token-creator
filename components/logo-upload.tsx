"use client";

import { useRef, useState } from "react";
import styles from "./logo-upload.module.css";

export function LogoUpload({ onUploaded, onError }: { onUploaded: (url: string) => void; onError: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("No file selected");
  const [uploading, setUploading] = useState(false);
  const upload = async (file?: File) => {
    if (!file) return;
    setFileName(file.name); setUploading(true);
    const form = new FormData(); form.append("file", file);
    try { const response = await fetch("/api/uploads", { method: "POST", body: form }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "Logo upload unavailable. You can continue without a logo."); onUploaded(body.logo_url); }
    catch (error) { onError(error instanceof Error ? error.message : "Logo upload unavailable. You can continue without a logo."); }
    finally { setUploading(false); }
  };
  return <div className={styles.control}><input ref={inputRef} className={styles.input} type="file" accept="image/*" tabIndex={-1} aria-hidden="true" onChange={(event) => void upload(event.target.files?.[0])}/><button type="button" className="button secondary" onClick={() => inputRef.current?.click()} disabled={uploading}>{uploading ? "Uploading…" : "Choose logo"}</button><span className={`helper ${styles.fileName}`}>{fileName}</span></div>;
}
