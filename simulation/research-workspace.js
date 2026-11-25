import Environment3D from './environment3d.js?v=20261125-v7';
import DispatchPanel from './dispatch-panel.js?v=20261125-v7';
import DecisionOverlay from './decision-overlay.js';
import EnvironmentVehicleSurface from './environment-vehicle-surface.js';

/** Optional display extensions around the unchanged canonical replay engine. */
export default class ResearchWorkspace {
  constructor({onSeek=()=>{},onVehicle=()=>{},onDataChange=()=>{}}={}){
    this.context=null;this.run=null;this.data=null;this.loading=false;this.error='';this.serial=0;this.cache=new Map();this.viewer=null;this.destroyed=false;this.onDataChange=onDataChange;
    this.overlay=new DecisionOverlay();
    this.panel=new DispatchPanel(document.getElementById('dispatch-panel'),{onSeek,onVehicle,onRouteComparison:payload=>this.overlay.setComparison(payload)});
    this.environment=new Environment3D({onStatus:value=>this.environmentStatus(value)});
    this.surface=new EnvironmentVehicleSurface(this.environment);
    this.visibility={buildings:true,roads:true,bridges:true,terrain:true};
  }
  setActive(camera){const active=camera==='decision';this.panel.setActive(active);this.overlay.setActive(active);}
  setScrubbing(active){
    const previous=this.environment.suspendRefresh;
    this.environment.suspendRefresh=!!active;
    if(previous&&!active)this.environment._lastRefresh=0;
  }
  async setRun(run){
    const serial=++this.serial;this.controller?.abort();this.run=run;this.data=null;this.loading=!!run;this.error='';this.overlay.setComparison(null);this.refreshPanel();
    if(!run)return;
    if(this.cache.has(run.id)){this.data=this.cache.get(run.id);this.loading=false;this.refreshPanel();return;}
    this.controller=new AbortController();
    try{
      if(!/^2023-11-(06|07|08|09|10|11|12)_(integrated|passenger_only)_S[012]$/.test(run.id))throw new Error('실행 ID를 확인할 수 없습니다.');
      const response=await fetch(`./data/decisions/${run.id}.json`,{signal:this.controller.signal});
      if(!response.ok)throw new Error(`배차 계획 파일을 읽지 못했습니다 (${response.status}). ZIP 전체를 풀었는지 확인해 주세요.`);
      const data=await response.json();if(serial!==this.serial||this.destroyed)return;
      if(data.runId&&data.runId!==run.id)throw new Error('배차 계획과 현재 실행의 ID가 다릅니다.');
      this.data=data;this.cache.set(run.id,data);while(this.cache.size>4)this.cache.delete(this.cache.keys().next().value);
    }catch(error){if(serial!==this.serial||error.name==='AbortError'||this.destroyed)return;this.error=error.message;}
    finally{if(serial===this.serial&&!this.destroyed){this.loading=false;this.refreshPanel();this.onDataChange();}}
  }
  update(context){
    this.context=context;
    // Reuse the exact facility positions that stage boarding and delivery.
    // Rebuild only when setNetwork() supplies a different placement map.
    this.syncServicePlacements();
    this.environment.update(context.states||[],{selectedId:context.selected,mode:this.scene?.mode==='manual'?'manual':context.camera});this.refreshPanel();
  }
  syncServicePlacements(){
    const placements=this.scene?.servicePlacements;
    if(!placements)return;
    const visibility={hubs:this.scene.layers?.hubs!==false,stops:this.scene.layers?.stops!==false};
    const signature=`${visibility.hubs}:${visibility.stops}`;
    if(placements===this.servicePlacements&&signature===this.serviceVisibility)return;
    this.servicePlacements=placements;this.serviceVisibility=signature;
    this.environment.setServicePlacements?.(placements,visibility);
  }
  updateScene(){this.surface.update();}
  refreshPanel(){
    if(!this.context||this.destroyed)return;
    const same=this.context.run?.id===this.run?.id;
    this.panel.update({...this.context,decisionData:same?this.data:null,loading:this.context.runLoading||this.loading||!same,error:same?this.error:''});
  }
  async attachScene(scene){
    if(!scene?.viewer||!scene.C||this.viewer===scene.viewer||this.destroyed)return;
    this.viewer=scene.viewer;this.scene=scene;this.syncServicePlacements();this.overlay.attach(this.viewer,scene.C);
    this.surface.attach(scene);
    try{
      await this.environment.attach(this.viewer,scene.C,{nativeBuildings:show=>{
        if(this.destroyed)return;
        if(scene._selectedEngine==='vworld')scene._setVWorldBuildings?.(show);
        else if(scene.buildings){scene.buildings.show=show;scene.viewer?.scene?.requestRender?.();}
      }});
      if(this.destroyed)return;this.environment.setVisible(this.visibility);
      if(this.context)this.environment.update(this.context.states||[],{selectedId:this.context.selected,mode:this.context.camera});
    }catch(error){this.environmentStatus({ready:false,message:`공간정보 표시를 준비하지 못했습니다. ${error.message}`});}
  }
  setEnvironmentVisible(kind,visible){this.visibility[kind]=!!visible;this.environment.setVisible(this.visibility);}
  environmentStatus(value){
    const output=document.getElementById('environment-status'),counts=document.getElementById('environment-counts');
    if(output)output.textContent=value.message||'실제 공간정보를 준비하고 있습니다.';
    if(counts){const n=value.loaded||{};counts.textContent=value.ready?`주변 건물 ${Number(n.buildings||0).toLocaleString('ko-KR')}동 표시`:'지도 연결 후 자동 표시';}
    // Display terrain refreshes must not cancel the base provider's in-flight
    // connection or its error fallback, which owns _terrainRevision.
    if(value.terrainChanged&&this.scene){this.scene._environmentHeightRevision=(this.scene._environmentHeightRevision||0)+1;this.scene.terrainHeights?.clear();this.scene.heightRequests?.clear();}
    this.status=value;
    if(this.context&&!this.destroyed)this.onDataChange();
  }
  destroy(){this.destroyed=true;++this.serial;this.controller?.abort();this.panel.destroy();this.overlay.destroy();this.surface.destroy();this.environment.destroy();this.cache.clear();}
}
