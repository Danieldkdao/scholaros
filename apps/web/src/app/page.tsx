import Link from 'next/link';
import { buttonVariants } from '@scholaros/ui/lib/button-variants';
import { ThemeShowcase } from '@scholaros/ui/components/theme-showcase';

export default function Home() {
  return (
    <>
      <nav
        aria-label="Get started"
        className="flex items-center justify-end gap-3 border-b px-6 py-4"
      >
        <Link href="/sign-in" className={buttonVariants({ variant: 'ghost' })}>
          Sign in
        </Link>
        <Link href="/demo" className={buttonVariants()}>
          Try demo
        </Link>
      </nav>
      <ThemeShowcase />
    </>
  );
}
