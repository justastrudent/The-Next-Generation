# 승객·시설 모형

이번 모형은 승하차·물류 작업 위치를 알아보기 위한 원본 제작 시각화 자산입니다. 실제 강내우체국 건축 외형, 개별 마을회관 외형, 쉼터형/팻말형 정류장 현황을 조사하여 복제한 자료가 아닙니다. 실제 서비스 노드 및 시뮬레이션 기록과 모형 배치·외형을 구분해야 합니다.

## 자산

- `assets/passenger.glb`: 키 약 1.68m. 얼굴, 머리카락, 재킷, 바지, 신발 및 손을 구분했습니다. 기존 애니메이션에서 사용하는 `ARM_L`, `ARM_R`, `LEG_L`, `LEG_R` 노드 이름과 X축 회전 규약을 유지합니다.
- `assets/service-post-office.glb`: 붉은 간판과 우체통이 있는 우체국 설명용 모형.
- `assets/service-village-hall.glb`: 박공지붕·마을회관 간판·벤치가 있는 물류하차지 설명용 모형.
- `assets/service-stop-shelter.glb`: 지붕·유리벽·벤치·시간표·정류장 간판을 갖춘 쉼터형 모형.
- `assets/service-stop-sign.glb`: 버스 그림과 정류장 표기가 있는 팻말형 모형.

모든 모델은 미터 단위이며 glTF 좌표의 +Y가 위, -Z가 정면입니다. 건물·정류장 모형의 원점은 지면 중앙입니다. 별도 텍스처나 원격 모델 다운로드 없이 하나의 GLB로 로드됩니다. 사용된 한글 간판은 Noto Sans CJK Bold 글꼴을 기하 형상으로 변환했습니다. 글꼴 파일 자체는 포함하지 않습니다.

기존 청주콜 차량 3종, 차량 내부 승객 및 택배 상자 모델은 변경하지 않았습니다.

## 제작·검증

`blender -b --python scripts/build_service_models.py -- <프로젝트 폴더>`로 재생성할 수 있습니다. Blender 4.3 및 Noto Sans CJK 글꼴이 필요합니다.

`docs/model-previews/`의 PNG는 전달되는 GLB를 다시 불러와 렌더한 결과입니다. `docs/service-model-validation.json`에는 실제 내보낸 모델의 경계 상자, 삼각형 개수, 용량을 기록했습니다. `python3 tests/test_service_models.py`는 파일 구조, 지면 높이, 얼굴 방향, 애니메이션 피벗, 간판 크기와 중심을 검사합니다. 이 검사는 실서비스 지도에서의 시설 실측 위치나 실제 건축 외형을 검증하는 것은 아닙니다.
