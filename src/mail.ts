import { randomUUID } from "node:crypto";
import { one, run, many } from "./db.ts";
type Mail = {
  id: string;
  to_email: string;
  subject: string;
  text: string;
  attempts: number;
};
export const emailConfigured = Boolean(
  process.env.RESEND_API_KEY && process.env.EMAIL_FROM,
);
export function queueEmail(
  to: string,
  subject: string,
  text: string,
  contextId: string | null = null,
) {
  const id = randomUUID();
  run(
    "INSERT INTO mail(id,context_id,to_email,subject,text,created_at) VALUES(?,?,?,?,?,?)",
    id,
    contextId,
    to,
    subject,
    text,
    Date.now(),
  );
  return id;
}
let delivering = false;
export async function deliverMail(id?: string) {
  if (!emailConfigured || delivering) return;
  delivering = true;
  try {
    const emails = id
      ? [
          one<Mail>("SELECT * FROM mail WHERE id=? AND status='pending'", id),
        ].filter((m): m is Mail => Boolean(m))
      : many<Mail>(
          "SELECT * FROM mail WHERE status='pending' AND attempts<5 ORDER BY created_at LIMIT 10",
        );
    for (const m of emails) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": m.id,
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM,
            to: [m.to_email],
            subject: m.subject,
            text: m.text,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error(`Resend returned ${response.status}`);
        run(
          "UPDATE mail SET status='accepted',attempts=attempts+1,error='' WHERE id=?",
          m.id,
        );
      } catch (error) {
        run(
          "UPDATE mail SET attempts=attempts+1,error=? WHERE id=?",
          error instanceof Error ? error.message : "Email request failed",
          m.id,
        );
      }
    }
  } finally {
    delivering = false;
  }
}
