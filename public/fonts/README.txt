Vendored web fonts (ROADMAP A4).

These files were previously loaded from Google Fonts, which disclosed every
visitor's IP address and User-Agent to a third party — from a tool whose whole
argument is that nothing leaves your machine. It also broke the air-gapped
install, where the fonts simply failed to resolve.

They are served from here instead, so the application makes no external request
of any kind. That is what allows the strict Content-Security-Policy the image
sends (ROADMAP E3): with a third-party font host, style-src and font-src would
have had to name it.

  Crimson Pro    400, 600, 700, 400 italic   display
  Inter          400, 500, 600               body
  JetBrains Mono 400, 500                    code

Each family ships latin and latin-ext subsets. Browsers fetch only the subsets a
page actually needs, via the unicode-range in the @font-face rules in
src/global.css.

All three are licensed under the SIL Open Font License 1.1. The upstream licence
for each is reproduced verbatim alongside this file, as that licence requires:

  OFL-CrimsonPro.txt
  OFL-Inter.txt
  OFL-JetBrainsMono.txt
