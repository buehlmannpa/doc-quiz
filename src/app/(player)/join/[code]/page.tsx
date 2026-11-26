import type { Metadata } from "next";
import { notFound } from "next/navigation";
import JoinForm from "./JoinForm";

export const metadata: Metadata = { title: "Beitreten" };

export default async function JoinCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^\d{6}$/.test(code)) notFound();
  return <JoinForm code={code} />;
}
