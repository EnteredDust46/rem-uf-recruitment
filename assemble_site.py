import json

with open('bootstrap.json.txt', 'r', encoding='utf-8') as f:
    bootstrap = json.load(f)

with open('style.css', 'r', encoding='utf-8') as f:
    css = f.read()

with open('app.js', 'r', encoding='utf-8') as f:
    js = f.read()

bootstrap_json = json.dumps(bootstrap)

html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>REM UF Recruitment</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Source+Sans+3:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
{css}
</style>
</head>
<body>
<div id="app">
  <div class="rail" id="rail"></div>
  <div class="main">
    <div class="topbar" id="topbar"></div>
    <div class="content" id="content"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
window.BOOTSTRAP = {bootstrap_json};
</script>
<script>
{js}
</script>
</body>
</html>
"""

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f"Wrote index.html: {len(html)} bytes")
