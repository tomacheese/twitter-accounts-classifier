#!/bin/bash
# feat/db-rebuild のチェックアウトから、4 つのイメージ (crawler、viewer、blocker、analyzer) をローカルでビルドしてタグで固定する。
# 本番ホストか、ビルド用のホストで実行する。
#
# CI は master へのマージ時にしかイメージを公開しない (マージ前の PR のビルドは push されない)。
# 切り替えはマージ前に行うため、切り替えで使うイメージはここで作る。
#
# 使い方: ops/db-rebuild/cutover/build-images.sh [--dry-run] [--ship-to <ssh 先>]
#   --ship-to  ビルド後に docker save | ssh <先> docker load で本番ホストへ送る (本番ホストでビルドすると RAM を共有する他コンテナに響く)
# 環境変数: BUILD_PLATFORM (既定 linux/amd64、本番ホストのアーキテクチャに合わせる)、IMAGE_PREFIX (既定 tac-rebuild)
#
# 出力の NEW_IMAGE_* を cutover.env へ書き写す。ワーキングツリーが汚れている場合は中断する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DRY_RUN=0
SHIP_TO=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run | -n) DRY_RUN=1 ;;
        --ship-to)
            SHIP_TO="${2:?--ship-to needs an ssh destination}"
            shift
            ;;
        *)
            echo "ERROR: unknown argument: $1" >&2
            exit 1
            ;;
    esac
    shift
done

PLATFORM="${BUILD_PLATFORM:-linux/amd64}"
PREFIX="${IMAGE_PREFIX:-tac-rebuild}"
cd "$REPO_ROOT"
if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: the working tree is not clean; the images must come from one commit" >&2
    exit 1
fi
SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short=12 HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

declare -A DOCKERFILE=([crawler]=crawler/Dockerfile [viewer]=viewer/Dockerfile [blocker]=blocker/Dockerfile [analyzer]=analyzer/Dockerfile)
TAGS=()
for name in crawler viewer blocker analyzer; do
    tag="$PREFIX/$name:$SHORT"
    TAGS+=("$tag")
    echo "== build $tag from ${DOCKERFILE[$name]} ($PLATFORM)" >&2
    if [ "$DRY_RUN" = 1 ]; then
        echo "[dry-run] docker build --platform $PLATFORM -f ${DOCKERFILE[$name]} -t $tag ." >&2
        continue
    fi
    docker build --platform "$PLATFORM" -f "${DOCKERFILE[$name]}" -t "$tag" \
        --build-arg "APPLICATION_VERSION=db-rebuild-$SHORT" --build-arg "GIT_REVISION=$SHA" --build-arg "BUILD_TIME=$BUILT_AT" \
        --label "org.opencontainers.image.revision=$SHA" --label "org.opencontainers.image.created=$BUILT_AT" .
done

if [ -n "$SHIP_TO" ]; then
    echo "== ship ${TAGS[*]} to $SHIP_TO" >&2
    if [ "$DRY_RUN" = 1 ]; then
        echo "[dry-run] docker save ${TAGS[*]} | gzip | ssh $SHIP_TO 'gunzip | docker load'" >&2
    else
        docker save "${TAGS[@]}" | gzip | ssh "$SHIP_TO" 'gunzip | docker load'
    fi
fi

cat <<EOF

# cutover.env に書く (commit $SHA)
NEW_IMAGE_CRAWLER=$PREFIX/crawler:$SHORT
NEW_IMAGE_VIEWER=$PREFIX/viewer:$SHORT
NEW_IMAGE_BLOCKER=$PREFIX/blocker:$SHORT
NEW_IMAGE_ANALYZER=$PREFIX/analyzer:$SHORT
EOF
