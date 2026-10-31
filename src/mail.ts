import { randomUUID } from "node:crypto";
import { run, many } from "./db.ts";
import { current } from "./runtime.ts";
type Mail = {
  id: string;
  to_email: string;
  subject: string;
  text: string;
  attempts: number;
};
export function emailConfigured() {
  const env = current().env;
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}
export async function queueEmail(
  to: string,
  subject: string,
  text: string,
  contextId: string | null = null,
) {
  const id = randomUUID();
  await run(
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
export async function deliverMail(id?: string) {
  if (!emailConfigured()) return;
  const emails = await many<Mail>(
    "SELECT * FROM mail WHERE status='pending' AND attempts<5 AND lease_until<=?" +
      (id ? " AND id=?" : "") +
      " ORDER BY created_at LIMIT 10",
    Date.now(),
    ...(id ? [id] : []),
  );
  for (const mail of emails) {
    const lease = randomUUID();
    const claimed = await run(
      "UPDATE mail SET lease_token=?,lease_until=? WHERE id=? AND status='pending' AND attempts<5 AND lease_until<=?",
      lease,
      Date.now() + 60000,
      mail.id,
      Date.now(),
    );
    if (!claimed.changes) continue;
    try {
      const env = current().env;
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.RESEND_API_KEY,
          "Content-Type": "application/json",
          "Idempotency-Key": mail.id,
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: [mail.to_email],
          subject: mail.subject,
          text: mail.text,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error("Provider rejected request");
      await run(
        "UPDATE mail SET status='accepted',attempts=attempts+1,error='',lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?",
        mail.id,
        lease,
      );
    } catch {
      await run(
        "UPDATE mail SET attempts=attempts+1,error='Email request failed',lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?",
        mail.id,
        lease,
      );
    }
  }
}
