import { confirmationHtml } from '@/lib/newsletter';

export function Signup({ name }: { name?: string }) {
  return (
    <section className="signup" id="signup">
      <h2>Get early access</h2>
      <form>
        <input type="email" placeholder="you@company.com" aria-label="Email" />
        <button type="submit">Join</button>
      </form>
      {name ? <p dangerouslySetInnerHTML={{ __html: confirmationHtml(name) }} /> : null}
    </section>
  );
}
