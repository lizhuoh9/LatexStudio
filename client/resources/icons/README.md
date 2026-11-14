# Original PaperStudio app mark

Original geometric artwork created for PaperStudio, 2026. A blue rounded frame contains a white
paper page, a geometric **P**, one baseline and a small orange folded corner. Colors follow the
application: scientific blue `#00659F`, white, and restrained orange `#E69F00`.

No third-party artwork, downloaded assets, font glyphs, Overleaf/Apple marks or Electron artwork
are used. This original artwork and its generator are distributed with PaperStudio under the
project's AGPL-3.0-only license.

- `paperstudio.png`: 512 × 512 RGBA master PNG.
- `paperstudio-256.png`: 256 × 256 RGBA runtime window/taskbar PNG.
- `paperstudio.ico`: Windows icon with 16, 24, 32, 48, 64, 128 and 256 pixel representations.
- `paperstudio.icns`: macOS icon, including native 512/1024 pixel PNG representations.

Maintainers may regenerate all four files from the source checkout with Python and Pillow:

```sh
python scripts/generate-app-icon.py
```

Ordinary users do not need Python: the generated icon files are application resources. Windows
packaging uses the ICO for the application and NSIS installer/uninstaller, and copies only the
fixed 256 PNG to `process.resourcesPath/icons/paperstudio-256.png` for the native window icon.
macOS packaging uses the ICNS for Finder/Dock and the same fixed runtime PNG. The Mac test build is
ad-hoc signed locally, not a Developer ID/notarized release; icon generation does not validate app launch.
The generator does not access the network, system fonts, executables or application user data.
