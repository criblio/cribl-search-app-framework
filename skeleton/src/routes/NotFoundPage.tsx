import { Link } from '@capra/core';
import { PATHS } from './paths';

export default function NotFoundPage() {
  return (
    <div>
      <h1>Page not found</h1>
      <p>
        This page does not exist. <Link href={PATHS.overview}>Back to the overview</Link>
      </p>
    </div>
  );
}
