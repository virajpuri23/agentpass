const FEATURES = [
  ['Billing', 'Subscriptions, invoices and dunning without writing webhook code.'],
  ['Auth', 'Email, passkeys and SSO with sessions that just work.'],
  ['Analytics', 'Signup funnels and retention, computed for you.'],
];

export function Features() {
  return (
    <section className="features">
      <ul>
        {FEATURES.map(([name, blurb]) => (
          <li key={name}>
            <b>{name}</b> {blurb}
          </li>
        ))}
      </ul>
    </section>
  );
}
