#!/usr/bin/env python3
"""Baut die Landingpage: Schrift einbetten. index.html ist die fertige Seite, artifact.html der Inhalt ohne Rahmen für die Vorschau."""
import base64, pathlib, re
hier = pathlib.Path(__file__).parent
quelle = (hier / 'index.src.html').read_text(encoding='utf-8')
schrift = base64.b64encode((hier.parent / 'app/src/fonts/hanken-grotesk-latin-wght-normal.woff2').read_bytes()).decode()
seite = quelle.replace('/*FONT*/', schrift)
(hier / 'index.html').write_text(seite, encoding='utf-8')
innen = re.sub(r'^<!doctype html>\s*<html lang="de">\s*<head>\s*', '', seite, flags=re.S)
innen = innen.replace('</head>\n<body>\n', '\n').replace('</body>\n</html>\n', '')
(hier / 'artifact.html').write_text(innen, encoding='utf-8')
print('ok', len(seite), len(innen))
