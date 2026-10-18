import { Hero } from '@/components/Hero';
import { Features } from '@/components/Features';
import { Signup } from '@/components/Signup';

export default function Home() {
  return (
    <main>
      <Hero />
      <Features />
      <Signup />
    </main>
  );
}
