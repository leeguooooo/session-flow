#!/bin/sh
# Creates a tiny git project and an implement -> review workflow for it, so a first real run
# changes code somewhere disposable:
#   sh examples/dev/setup.sh ~/sflow-demo
#   sflow run ~/sflow-demo/.sflow/implement-review.json
set -eu
target=${1:?usage: setup.sh <new directory>}
[ -e "$target" ] && { echo "$target already exists; pick a new directory" >&2; exit 1; }
command -v sflow >/dev/null 2>&1 || { echo "sflow not found; install it first" >&2; exit 1; }
mkdir -p "$target"
cd "$target"
cat > greet.sh <<'EOF'
#!/bin/sh
# usage: greet.sh NAME
name=${1:?usage: greet.sh NAME}
echo "Hello, $name!"
EOF
cat > test.sh <<'EOF'
#!/bin/sh
# Run: sh test.sh
set -e
[ "$(sh greet.sh Ada)" = "Hello, Ada!" ] || { echo "FAIL: plain greeting"; exit 1; }
echo "ok"
EOF
printf '.sflow/\n' > .gitignore
git init -q
git add greet.sh test.sh .gitignore
git -c user.name=sflow-demo -c user.email=sflow-demo@example.invalid commit -qm "demo: greet.sh with one test"
sflow init implement-review --write --cwd . --out .sflow/implement-review.json \
  --task "Add a --shout option to greet.sh that prints the greeting in upper case (sh greet.sh --shout Ada prints HELLO, ADA!). Add a test for it to test.sh and keep the existing test passing; sh test.sh must print ok."
echo
echo "demo project: $(pwd)"
echo "next: sflow run $(pwd)/.sflow/implement-review.json"
