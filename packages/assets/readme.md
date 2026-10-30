# Shared assets

Store shared static files under `src/`, grouped by purpose, using lowercase kebab-case filenames. For example, `src/images/scholaros-logo.png` is imported as `@scholaros/assets/images/scholaros-logo.png`.

This package exports the original files; each consuming app bundles the assets it imports. No package build or shared public server is required.

Next.js:

```tsx
import Image from 'next/image';
import logo from '@scholaros/assets/images/scholaros-logo.png';

<Image src={logo} alt="ScholarOS" />;
```

Desktop renderer:

```tsx
import logo from '@scholaros/assets/images/scholaros-logo.png';

<img src={logo} alt="ScholarOS" />;
```

The logo path above is illustrative; add the actual image before importing it. Next.js provides metadata for static raster image imports; Vite provides a URL string. Keep these framework-specific types in the consuming apps, rather than adding global image declarations or a JavaScript barrel to this package. SVG imports are file assets, not React components.

Use this package for shared images, illustrations, media, and fonts. Keep files requiring fixed web URLs in `apps/web/public`, Electron installer icons in desktop packaging resources, and student downloads or uploads in runtime storage. Imports here are for renderer assets; Electron main-process filesystem resources require explicit packaging configuration.
