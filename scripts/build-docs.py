# -*- coding: utf-8 -*-
"""Gera as paginas estaticas de docs/ a partir dos markdown do projeto.

    python scripts/build-docs.py

Produz:
    docs/spec.html   - o design doc renderizado
    docs/brand.html  - guia visual da marca Mind Sculptor
"""
import io
import os
import re
import sys

import markdown

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "docs", "superpowers", "specs",
                    "2026-08-27-agente-atendimento-multinicho-design.md")
TOKENS = os.path.join(ROOT, "assets", "brand", "tokens.css")
LOGO = os.path.join(ROOT, "assets", "brand", "logo-mark.svg")

PAGE_CSS = """
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0; background:var(--color-background); color:var(--color-foreground);
  font-family:var(--font-ui); font-size:16px; line-height:1.65;
  -webkit-font-smoothing:antialiased;
}
.shell{display:grid; grid-template-columns:286px minmax(0,1fr); min-height:100dvh}
nav{
  border-right:1px solid var(--color-border); background:var(--color-surface);
  padding:22px 16px; position:sticky; top:0; height:100dvh; overflow-y:auto;
}
.logo{display:flex; align-items:center; gap:11px; margin-bottom:22px;
  padding:0 6px; text-decoration:none}
.logo svg{width:38px; height:38px; flex:none}
.logo .name{font-weight:700; font-size:14px; letter-spacing:.02em;
  line-height:1.15; color:var(--color-foreground)}
.logo .name span{display:block; font-weight:400; font-size:11px;
  color:var(--color-foreground-dim); font-family:var(--font-mono);
  letter-spacing:0; margin-top:2px}
nav a.sec{
  display:block; padding:7px 10px; margin:1px 0; border-radius:var(--radius-sm);
  color:var(--color-foreground-dim); text-decoration:none; font-size:13.5px;
  border-left:2px solid transparent;
  transition:background var(--dur-fast) var(--ease-out),
             color var(--dur-fast) var(--ease-out);
}
nav a.sec:hover{background:var(--color-muted); color:var(--color-foreground)}
nav a.sec.active{color:var(--color-primary); border-left-color:var(--color-accent);
  background:var(--color-muted)}
nav a.lvl3{padding-left:24px; font-size:12.5px}
:focus-visible{outline:2px solid var(--color-ring); outline-offset:2px; border-radius:3px}
main{padding:54px 46px 120px; max-width:940px}
h1{font-size:35px; line-height:1.18; letter-spacing:-.022em; margin:0 0 10px}
h2{font-size:23px; letter-spacing:-.012em; margin:56px 0 14px;
  padding-bottom:9px; border-bottom:1px solid var(--color-border)}
h3{font-size:17px; margin:32px 0 10px}
strong{font-weight:600}
hr{border:0; border-top:1px solid var(--color-border); margin:44px 0}
a{color:var(--color-primary)}
table{border-collapse:collapse; width:100%; margin:18px 0; font-size:14px;
  font-variant-numeric:tabular-nums}
thead th{background:var(--color-muted); text-align:left; font-weight:600;
  font-size:11.5px; text-transform:uppercase; letter-spacing:.055em;
  color:var(--color-foreground-dim)}
th,td{border:1px solid var(--color-border); padding:9px 12px; vertical-align:top}
tbody tr{transition:background var(--dur-fast) var(--ease-out)}
tbody tr:hover{background:var(--color-muted)}
code{font-family:var(--font-mono); font-size:.88em; background:var(--color-muted);
  border:1px solid var(--color-border); border-radius:4px; padding:1px 5px}
pre{background:var(--color-surface); border:1px solid var(--color-border);
  border-radius:var(--radius-md); padding:16px 18px; overflow-x:auto;
  font-size:13px; line-height:1.55}
pre code{background:none; border:0; padding:0}
blockquote{margin:18px 0; padding:2px 18px;
  border-left:3px solid var(--color-accent); color:var(--color-foreground-dim)}
.meta{display:inline-flex; gap:9px; align-items:center; font-family:var(--font-mono);
  font-size:12px; color:var(--color-foreground-dim);
  border:1px solid var(--color-border); background:var(--color-muted);
  border-radius:var(--radius-pill); padding:4px 13px; margin-bottom:26px}
.toolbar{position:fixed; top:14px; right:18px; display:flex; gap:8px; z-index:var(--z-sticky)}
.toolbar a,.toolbar button{
  display:inline-flex; align-items:center; min-height:38px; padding:0 15px;
  border-radius:var(--radius-md); cursor:pointer; text-decoration:none;
  border:1px solid var(--color-border); background:var(--color-surface-raised);
  color:var(--color-foreground); font-family:inherit; font-size:13px;
  transition:background var(--dur-fast) var(--ease-out),
             border-color var(--dur-fast) var(--ease-out);
}
.toolbar a:hover,.toolbar button:hover{
  background:var(--color-muted); border-color:var(--color-border-strong)}

/* --- pagina de marca --- */
.hero{display:flex; align-items:center; gap:26px; padding:38px 34px; margin-bottom:8px;
  border:1px solid var(--color-border); border-radius:var(--radius-lg);
  background:var(--color-surface)}
.hero svg{width:104px; height:104px; flex:none}
.hero h1{margin:0}
.swatches{display:grid; gap:12px; margin:20px 0 8px;
  grid-template-columns:repeat(auto-fill,minmax(158px,1fr))}
.sw{border:1px solid var(--color-border); border-radius:var(--radius-md); overflow:hidden}
.sw .chip{height:76px}
.sw .lab{padding:9px 11px; font-family:var(--font-mono); font-size:11.5px;
  background:var(--color-surface); border-top:1px solid var(--color-border)}
.sw .lab b{display:block; font-family:var(--font-ui); font-size:12.5px;
  font-weight:600; margin-bottom:3px; letter-spacing:.01em}
.sw .lab span{color:var(--color-foreground-dim)}
.demo{display:flex; flex-wrap:wrap; gap:11px; align-items:center; margin:18px 0}
.btn{min-height:42px; padding:0 20px; border-radius:var(--radius-md); border:0;
  background:var(--color-primary-fill); color:var(--color-on-primary);
  font-family:inherit; font-size:14px; font-weight:500; cursor:pointer;
  display:inline-flex; align-items:center;
  transition:filter var(--dur-fast) var(--ease-out)}
.btn:hover{filter:brightness(1.09)}
.btn.ghost{background:transparent; color:var(--color-primary);
  border:1px solid var(--color-border-strong)}
.btn.ghost:hover{background:var(--color-muted)}
.pill{display:inline-flex; align-items:center; gap:6px; padding:4px 12px;
  border-radius:var(--radius-pill); font-size:12.5px; font-weight:500;
  background:var(--color-accent-soft); color:var(--color-primary);
  border:1px solid var(--color-border-strong)}
.note{border-left:3px solid var(--color-accent); background:var(--color-muted);
  padding:13px 17px; border-radius:0 var(--radius-md) var(--radius-md) 0; margin:18px 0;
  font-size:14.5px}

@media (max-width:900px){
  .shell{grid-template-columns:1fr}
  nav{position:static; height:auto; border-right:0;
    border-bottom:1px solid var(--color-border)}
  main{padding:26px 18px 80px}
  h1{font-size:27px}
  .hero{flex-direction:column; text-align:center; padding:26px 18px}
  .toolbar{position:static; padding:12px 18px 0; justify-content:flex-end}
}
"""

THEME_JS = """
(function(){
  var KEY='ms-theme', root=document.documentElement;
  try{ var s=localStorage.getItem(KEY); if(s) root.setAttribute('data-theme',s); }catch(e){}
  var b=document.getElementById('theme');
  if(b) b.addEventListener('click',function(){
    var cur=root.getAttribute('data-theme');
    if(!cur) cur=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
    var next=cur==='dark'?'light':'dark';
    root.setAttribute('data-theme',next);
    try{ localStorage.setItem(KEY,next); }catch(e){}
  });
  var secs=[].slice.call(document.querySelectorAll('main h2[id],main h3[id]'));
  var links={};
  [].forEach.call(document.querySelectorAll('nav a.sec'),function(a){
    links[a.getAttribute('href').slice(1)]=a;
  });
  if(secs.length && 'IntersectionObserver' in window){
    var obs=new IntersectionObserver(function(es){
      es.forEach(function(e){
        var a=links[e.target.id]; if(!a) return;
        if(e.isIntersecting){
          for(var k in links) links[k].classList.remove('active');
          a.classList.add('active');
        }
      });
    },{rootMargin:'-10% 0px -80% 0px'});
    secs.forEach(function(s){obs.observe(s);});
  }
})();
"""


def slug(text):
    s = re.sub(r"[`*_]", "", text.lower())
    s = re.sub(r"[^a-z0-9À-ſ]+", "-", s)
    return s.strip("-")


def read(path):
    with io.open(path, encoding="utf-8") as fh:
        return fh.read()


def shell(title, tokens, logo, nav_links, body, active_page):
    tabs = {"spec": ("spec.html", "Design"), "brand": ("brand.html", "Marca")}
    toolbar = []
    for key, (href, label) in tabs.items():
        if key != active_page:
            toolbar.append('<a href="%s">%s</a>' % (href, label))
    toolbar.append('<button id="theme" aria-label="Alternar tema claro e escuro">Tema</button>')

    return u"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(title)s</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Fira+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
%(tokens)s
%(page)s
</style>
</head>
<body>
<div class="toolbar">%(toolbar)s</div>
<div class="shell">
  <nav aria-label="Sumario">
    <a class="logo" href="spec.html">
      %(logo)s
      <span class="name">MIND SCULPTOR<span>agente multi-nicho</span></span>
    </a>
    %(nav)s
  </nav>
  <main>%(body)s</main>
</div>
<script>%(js)s</script>
</body>
</html>""" % {
        "title": title, "tokens": tokens, "page": PAGE_CSS, "logo": logo,
        "nav": "\n    ".join(nav_links), "body": body,
        "toolbar": "\n  ".join(toolbar), "js": THEME_JS,
    }


def build_spec(tokens, logo):
    raw = read(SPEC)
    toc = [(len(m.group(1)), m.group(2).strip())
           for m in re.finditer(r"^(#{2,3})\s+(.*)$", raw, re.M)]

    body = markdown.markdown(raw, extensions=["tables", "fenced_code", "attr_list"])

    def add_id(match):
        tag, inner = match.group(1), match.group(2)
        return '<%s id="%s">%s</%s>' % (
            tag, slug(re.sub(r"<[^>]+>", "", inner)), inner, tag)

    body = re.sub(r"<(h[23])>(.*?)</\1>", add_id, body, flags=re.S)

    links = []
    for level, text in toc:
        clean = re.sub(r"[`*]", "", text)
        links.append('<a class="sec%s" href="#%s">%s</a>' % (
            "" if level == 2 else " lvl3", slug(clean), clean))

    return shell(u"Agente Multi-Nicho — Design", tokens, logo, links, body, "spec")


PALETTE = [
    ("brand-300", "#FFC24A", "brilho das pecas"),
    ("brand-400", "#FFA51C", "ambar do topo"),
    ("brand-500", "#FF7A1A", "laranja-nucleo"),
    ("brand-600", "#F04310", "vermelho-laranja"),
    ("brand-700", "#C42D08", "sombra / acao no claro"),
    ("brand-900", "#5A1302", "profundidade"),
    ("ink-950", "#000000", "o preto da logo"),
    ("ink-850", "#131009", "superficie elevada"),
]


def build_brand(tokens, logo):
    sw = []
    for name, hexv, role in PALETTE:
        sw.append(
            '<div class="sw"><div class="chip" style="background:%s"></div>'
            '<div class="lab"><b>%s</b><span>%s &middot; %s</span></div></div>'
            % (hexv, name, hexv, role))

    body = u"""
<div class="hero">%s<div><h1>Mind Sculptor</h1>
<p style="margin:6px 0 0;color:var(--color-foreground-dim)">
Sistema visual do painel. A marca vive no escuro &mdash; preto puro com laranja em brasa.</p></div></div>

<h2 id="rampa">Rampa da marca</h2>
<p>Extraida da logo: as pecas superiores do quebra-cabeca sao ambar, a base e o rosto puxam
para o vermelho. Essa progressao vira a rampa inteira do produto.</p>
<div class="swatches">%s</div>

<h2 id="contraste">Por que o tema claro usa um laranja diferente</h2>
<p>O laranja da logo (<code>#FF7A1A</code>) rende cerca de <b>2.6:1</b> sobre branco. Reprova
o minimo de 4.5:1 da WCAG para texto. Entao o tema claro usa a ponta profunda da mesma
rampa em tudo que carrega texto, e reserva o laranja vivo para o que nao precisa ser lido:
icones, bordas, series de grafico.</p>
<div class="note">No escuro o problema desaparece. <code>#FF8A2B</code> sobre preto da
<b>8.9:1</b> &mdash; e por isso que a marca parece mais ela mesma no tema escuro.</div>

<h2 id="componentes">Componentes</h2>
<div class="demo">
  <button class="btn">Assumir conversa</button>
  <button class="btn ghost">Devolver ao agente</button>
  <span class="pill">Qualificado</span>
  <span class="pill" style="background:transparent;color:var(--color-foreground-dim)">Aguardando</span>
</div>
<table>
<thead><tr><th>Contato</th><th>Etapa</th><th>Ultima msg</th><th style="text-align:right">Valor</th></tr></thead>
<tbody>
<tr><td>Salu Barbato</td><td>Agendou</td><td>ha 4 min</td><td style="text-align:right">R$ 600,00</td></tr>
<tr><td>Renata Alves</td><td>Qualificado</td><td>ha 22 min</td><td style="text-align:right">R$ 1.240,00</td></tr>
<tr><td>Pedro Lima</td><td>Respondeu</td><td>ha 1 h</td><td style="text-align:right">R$ 90,00</td></tr>
</tbody></table>
<p style="color:var(--color-foreground-dim);font-size:14px">
Numeros em <b>Fira Code</b> com <code>font-variant-numeric: tabular-nums</code> &mdash;
sem isso as colunas dancam a cada atualizacao ao vivo.</p>

<h2 id="tipografia">Tipografia</h2>
<p><b>Fira Sans</b> na interface. <b>Fira Code</b> em numero, horario, telefone e
identificador. A logo usa uma serifada display, que fica so na logo: serifada em tabela
densa cansa a leitura.</p>

<h2 id="uso">Regras de uso</h2>
<ul>
<li>O gradiente da marca aparece em <b>um</b> lugar por tela, no maximo.</li>
<li>Icones sao Lucide, traco 1.5px. Emoji nunca faz papel de icone.</li>
<li>Cada tenant sobrescreve <code>--color-primary</code> e a logo pelo <code>marca.yaml</code>;
o resto da rampa segue o padrao.</li>
<li>Estado de erro e conversa escalada usam <code>--color-destructive</code>, sempre
acompanhado de icone ou texto &mdash; nunca so a cor.</li>
</ul>
""" % (logo, "\n".join(sw))

    links = [
        '<a class="sec" href="#rampa">Rampa da marca</a>',
        '<a class="sec" href="#contraste">Contraste claro/escuro</a>',
        '<a class="sec" href="#componentes">Componentes</a>',
        '<a class="sec" href="#tipografia">Tipografia</a>',
        '<a class="sec" href="#uso">Regras de uso</a>',
    ]
    return shell(u"Mind Sculptor — Marca", tokens, logo, links, body, "brand")


def main():
    tokens = read(TOKENS)
    logo = re.sub(r"<\?xml[^>]*\?>", "", read(LOGO)).strip()

    targets = [
        (os.path.join(ROOT, "docs", "spec.html"), build_spec(tokens, logo)),
        (os.path.join(ROOT, "docs", "brand.html"), build_brand(tokens, logo)),
    ]
    for path, html in targets:
        with io.open(path, "w", encoding="utf-8") as fh:
            fh.write(html)
        sys.stdout.write("gerado: %s (%d bytes)\n" % (os.path.basename(path), len(html)))


if __name__ == "__main__":
    main()
