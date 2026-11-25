/** Display-only plan geometry. Never changes vehicle states or the simulation clock. */
export default class DecisionOverlay {
  constructor(){this.viewer=null;this.C=null;this.entities=[];this.active=false;this.payload=null;this.signature='';}
  attach(viewer,C){if(this.viewer===viewer)return;this.detach();this.viewer=viewer;this.C=C;this.draw();}
  setActive(value){this.active=!!value;for(const entity of this.entities)entity.show=this.active;this.viewer?.scene?.requestRender?.();}
  setComparison(payload){
    const signature=payload?JSON.stringify([payload.id,payload.vehicleId,payload.previousPaths,payload.currentPaths]):'';
    if(signature===this.signature)return;this.signature=signature;this.payload=payload;this.draw();
  }
  clear(){if(this.viewer&&!this.viewer.isDestroyed?.())for(const entity of this.entities)this.viewer.entities.remove(entity);this.entities=[];}
  draw(){
    this.clear();const v=this.viewer,C=this.C,p=this.payload;if(!v||!C||!p||v.isDestroyed?.())return;
    const groups=[['previous',p.previousPaths,'#adbac9',3.5],['current',p.currentPaths,'#58e3c3',4.5]];
    for(const [kind,paths,color,width] of groups){
      for(const [index,path] of (paths||[]).entries()){
        if(!Array.isArray(path)||path.length<2||path.some(q=>!Array.isArray(q)||!Number.isFinite(q[0])||!Number.isFinite(q[1])||Math.abs(q[0])>180||Math.abs(q[1])>90))continue;
        const tint=C.Color.fromCssColorString(color).withAlpha(.86);
        const material=kind==='previous'&&C.PolylineDashMaterialProperty?new C.PolylineDashMaterialProperty({color:tint,dashLength:14}):tint;
        this.entities.push(v.entities.add({id:`decision-${kind}-${index}`,name:kind==='previous'?'변경 전 계획 · 도로망 복원':'변경 후 계획 · 도로망 복원',show:this.active,
          polyline:{positions:C.Cartesian3.fromDegreesArray(path.flatMap(q=>[q[0],q[1]])),width,material,clampToGround:true,...(C.ClassificationType?{classificationType:C.ClassificationType.TERRAIN}:{})}}));
      }
    }
    v.scene.requestRender?.();
  }
  detach(){this.clear();this.viewer=null;this.C=null;}
  destroy(){this.detach();this.payload=null;}
}
