import path from 'node:path';

export function portableRelative(base, file) {
  return path.relative(base, file).split(path.sep).join('/');
}

function clean(relativePath) {
  return relativePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

const TRANSIENT_PACKAGE_DIRECTORIES = [
  'Descendants/.test-dist',
  'Descendants/node_modules',
  'Descendants/coverage',
  'Descendants/.git',
];

/** Machine-local/generated directories are not durable handoff artifacts. */
export function isTransientPackageDirectory(relativePath) {
  const rel = clean(relativePath);
  return TRANSIENT_PACKAGE_DIRECTORIES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

/**
 * Package SHA covers durable handoff artifacts, not local execution products.
 * Running tests or installing dependencies must not mutate the release ledger's scope.
 */
export function isTransientPackagePath(relativePath) {
  const rel = clean(relativePath);
  return rel === 'PACKAGE_CONTENT_SHA256.txt' || isTransientPackageDirectory(rel);
}

export function isDurablePackagePath(relativePath) {
  return !isTransientPackagePath(relativePath);
}
