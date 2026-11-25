# 외부 라이브러리와 공간정보

## CesiumJS

웹앱은 공식 npm 패키지 `cesium@1.124.0`의 `Build/Cesium` 배포물을
`dist/vendor/cesium/`에 포함합니다. 라이브러리 로딩을 외부 CDN에 의존하지
않도록 원본 배포 파일을 함께 제공합니다.

CesiumJS는 Apache License 2.0으로 배포됩니다. 원문은
`dist/vendor/cesium/LICENSE.md`, 포함된 다른 구성요소의 정보는
`dist/vendor/cesium/ThirdParty.json` 및 배포물의 저작권 고지를 확인하세요.

- https://github.com/CesiumGS/cesium
- https://www.npmjs.com/package/cesium/v/1.124.0

## 지도 서비스

Esri World Imagery의 실제 위성영상은 온라인으로 불러옵니다. 화면의
출처 고지에는 Esri, Maxar, Earthstar Geographics 및 GIS User Community가
포함됩니다. 데이터의 제공 범위·갱신일·사용조건은 공급원에 따릅니다.

실제 지형의 기본 공급원 및 옵션은 `docs/map-rendering.md`에 설명합니다.
Cesium ion에 연결하는 실제 OSM 건물과 World Terrain은 사용자 토큰의
권한·제공 범위에 따릅니다. 앱은 임의의 건물이나 지형을 실측 공간정보로
생성하지 않습니다.

## 연구자료

도로망·호출·물류·실행결과 및 원래 네트워크 처리 코드는 사용자가 지정한
`km-minsang/MetroRookies` 저장소에서 읽었습니다. 출처와 원본 파일 해시는
`dist/data/provenance.json`, 가져온 원래 코드의 정보는
`scripts/vendor/gangnae/PROVENANCE.md`에 보관합니다.

## 시각 모델

차량·사람·물류 상자의 GLB 모델은 `scripts/generate_models.py`에서
절차적으로 생성했습니다. 특정 차량 제작사나 실제 인물을 재현한 모델이
아니며, 서비스 과정의 시각적 설명에 사용합니다.
