# MetroRookies · 청주콜 버스 외형·표시 패치

제공한 청주콜 버스 측면 사진을 참고해 차량 3대의 외형을 다시 만든 패치입니다. 기존 V-World 지도에서 사용합니다.

## 가장 쉬운 적용 방법

1. ZIP을 압축 해제합니다.
2. 나온 `cheongju-drt-design-patch` 폴더를 **기존 `scene3d.js`가 있는 시뮬레이터 폴더 안**에 넣습니다.
3. 패치 폴더 안의 **`apply_design.bat`을 더블 클릭**합니다. 기존 로컬 서버를 실행할 때 사용하는 Python 3가 필요합니다.
4. `INSTALLED` 또는 `ALREADY INSTALLED` 안내를 확인합니다.
5. 시뮬레이터 브라우저에서 **Ctrl + Shift + R**로 새로고침합니다.
6. 차량 1·2·3 중 하나를 선택해 추적 화면에서 외형을 확인합니다.

패치 파일은 ZIP 내부에서 실행하지 말고 먼저 압축을 풀어야 합니다. `scene3d.js`를 찾을 수 없다는 안내가 나오면 패치 폴더가 실제 시뮬레이터 폴더 안에 있는지 확인합니다.

명령행으로 직접 지정하려면:

```bash
python apply_design.py "시뮬레이터 폴더의 전체 경로"
```

설치 전 위치와 파일 검사만 하려면 끝에 `--check`를 붙입니다.

## 무엇이 달라지나요?

| 항목 | 반영 내용 |
|---|---|
| 차체 | 긴 고상 밴 비율, 경사진 전면 유리와 보닛, 흰색 차체 |
| 배색 | 검은 창문 띠, 빨간 측면 띠, 뒤쪽 상단 연두색, 앞쪽 상단 파란색 |
| 표기 | ‘청주콜 버스’ 문구와 01·02·03 식별 번호 |
| 세부 형상 | 바퀴·휠, 검은 범퍼와 트림, 미러, 손잡이, 문 이음선 |
| 지도 표시 | 차체의 발광 외곽선 제거, 실제 미터 단위 크기로 표시 |
| 라벨 | 기존 차량·작업 정보판을 하나의 작은 둥근 정보판으로 통합 |
| 승객 | 슬라이딩 도어 위치에 맞춰 탑승·하차 연출 위치 조정 |
| 물류 | 뒤쪽 양문 개방, 긴 차체 뒤에서 상자 적재·하역 |
| 정차 | 같은 서비스 지점의 차량을 표시용 9m 간격으로 분리 |

차량 세 대는 공통 배색을 사용하고 번호와 라벨의 작은 색 점으로 구분합니다. **01·02·03은 시뮬레이터 차량 식별값**이며 실차의 등록 번호나 실제 운행 편성을 의미하지 않습니다.

멀리서 보면 차량 모형이 작아지는 것은 실제 미터 단위 크기 표시입니다. 차량을 선택하고 추적 화면으로 들어가면 세부 외형을 볼 수 있습니다. 모델만 크게 부풀리는 방식은 사람·상자와 상대 크기가 달라져 사용하지 않습니다.

## 연구 데이터와 표시 좌표

원본 로그, 도로 경로, 날짜·시나리오, 승하차·배송 시각, 승객·물류 수, 강내우체국 Depot, 강내면 경계 파일은 이 패치의 수정 대상이 아닙니다. `data`, `app.js`, `vworld-scene.js`를 교체하지 않습니다.

정차 분리는 화면에서 차체가 겹치지 않게 하는 **시각화용 배치**입니다. 실제 주차면이나 차선 측량자료를 복원한 것이 아닙니다. 원본 상태는 `rec.state`, 표시용 상태는 `rec.displayState`로 구분합니다. 가상 주차 탐색은 원래 서비스 지점 주변의 표시 배치만 사용하고 실제 주차장 주행을 생성하지 않습니다.

알려진 정차 상태에만 간격을 적용합니다. 주행·미확인 상태에는 표시용 이동을 추가하지 않습니다. 승객, 상자, 차량 정보판과 추적 카메라도 같은 표시 기준점을 사용합니다.

## 적용 파일

새 파일:

- `cheongju-design.js`
- `assets/drt-cheongju-01.glb`
- `assets/drt-cheongju-02.glb`
- `assets/drt-cheongju-03.glb`

기존 `scene3d.js`의 `export default MetroScene;` 바로 앞에는 다음 표시 구간만 추가합니다.

```javascript
// BEGIN METROROOKIES_CHEONGJU_DESIGN_V1
import { installCheongjuDesign } from './cheongju-design.js';
installCheongjuDesign(MetroScene);
// END METROROOKIES_CHEONGJU_DESIGN_V1
export default MetroScene;
```

설치기는 이 작업을 자동으로 수행합니다. 수동으로 적용할 때는 새 파일 4개를 해당 위치로 복사한 뒤 위의 BEGIN~END 구간을 추가하면 됩니다. `export default MetroScene;`는 중복으로 넣지 않습니다.

## 이전 외형으로 되돌리기

같은 패치 폴더의 `restore_design.bat`을 실행하고 브라우저를 강력 새로고침합니다. 최초 `scene3d.js`는 `design-backup` 폴더에 백업합니다. 복원은 표시된 구간을 제거하며, 그동안 다른 부분에 추가한 사용자 코드는 보존합니다. 설치 후 직접 수정한 패치 파일이 있으면 자동으로 덮어쓰지 않고 충돌을 알립니다.

## 모델의 근거와 한계

제공한 측면 사진의 차체 비율·창문·배색·표기를 참고해 제작한 3D 모형입니다. 제조사의 공식 CAD 또는 실측 도면을 사용하지 않았습니다. 사진에 없는 반대쪽, 실내, 후면의 일부 구조는 시뮬레이션 연출을 위해 구성했습니다. 차량 길이 등은 시각화용 근사치이며 공식 제원으로 인용하지 않습니다. 제공 사진의 실제 등록번호를 추정해 만들지 않았습니다.

실제 V-World에서의 최종 색감·고도·가림은 사용자 지도의 조명과 지형 공급 상태에 따라 달라집니다. `preview` 폴더의 그림은 전달한 GLB 자산을 확인하기 위한 스튜디오 렌더입니다. V-World 현장 화면을 촬영한 결과가 아닙니다.

## 수정·재생성 자료

`source`에 모델 제작 스크립트, `tests`에 설치기와 렌더링 연결 검사, `validation`에 검증 결과를 함께 제공합니다. GLB에는 텍스처가 들어 있으므로 별도 이미지 다운로드가 필요하지 않습니다.

모델 재생성용 스크립트는 개발자용이며 Blender 4.3 계열, 해당 Blender Python의 Pillow, 한글 글꼴이 필요합니다. 기본 글꼴 경로는 Linux의 Noto Sans CJK 또는 Windows의 맑은 고딕입니다. 다른 경로는 `METRO_CJK_BOLD`, `METRO_CJK_REGULAR` 환경변수로 지정합니다. 일반 패치 설치에는 Blender나 추가 Python 패키지가 필요하지 않습니다.

주요 API 근거: [ModelGraphics](https://cesium.com/learn/cesiumjs/ref-doc/ModelGraphics.html), [BillboardGraphics](https://cesium.com/learn/cesiumjs/ref-doc/BillboardGraphics.html), [PropertyBag](https://cesium.com/learn/cesiumjs/ref-doc/PropertyBag.html). V-World가 제공하는 viewer 위의 기존 엔티티 표시를 수정하며, 새 지도 엔진을 생성하지 않습니다.
