#!/usr/bin/env bash
# 공유 링크를 깃랩 Pages 에 올린다.  실행: npm run deploy
#
# public/ 은 8MB 가 넘는 빌드 결과라 main 에 커밋하지 않는다. 대신 `pages` 라는
# 일회용 가지에 통째로 덮어쓴다. 매번 새로 만들어 강제로 밀어넣으므로
# 저장소 역사에 빌드 결과가 쌓이지 않는다.
#
# (변수 이름은 영문으로. bash 는 한글 변수명을 못 쓴다.)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d public ] || { echo "public/ 이 없습니다. 먼저 npm run bundle 을 실행하세요."; exit 1; }

remote=$(git remote get-url origin)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cp -r public "$tmp/public"
cp deploy/pages-ci.yml "$tmp/.gitlab-ci.yml"

cd "$tmp"
git init -q
git add -A
git commit -q -m "공유 링크 $(date '+%Y-%m-%d %H:%M')"
git push -q -f "$remote" HEAD:pages

echo "올렸습니다. 깃랩에서 파이프라인이 끝나면 주소가 나옵니다:"
echo "  프로젝트 → Deploy → Pages"
