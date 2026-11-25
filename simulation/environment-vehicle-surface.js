/**
 * Display-only height alignment on the supplied bridge footprints.
 * Horizontal route, clock, passenger counts and parcel counts stay canonical.
 * The deck altitude is an approach-terrain estimate, not a measured bridge Z.
 */
export default class EnvironmentVehicleSurface {
  constructor(environment){this.environment=environment;this.scene=null;this.originalHeight=null;this.records=new Map();}
  attach(scene){
    if(this.scene===scene)return;this.detach();this.scene=scene;
    if(typeof scene?._height==='function'){
      this.originalHeight=scene._height;const original=this.originalHeight,environment=this.environment;
      scene._height=function(lon,lat){const vehicle=this.states?.find(s=>String(s.id)===String(this.selected));const deck=environment.surfaceHeightAt?.(Number(lon),Number(lat),vehicle?.heading);return Number.isFinite(deck)?deck:original.call(this,lon,lat);};
    }
  }
  update(){
    const scene=this.scene,C=scene?.C,v=scene?.viewer;if(!C?.HeightReference||!v)return;
    for(const rec of scene.vehicles?.values?.()||[]){
      for(const [entity,property] of [[rec.entity,'model'],[rec.person,'model'],[rec.parcel,'model'],[rec.serviceLabel,'billboard']]){
        const graphics=entity?.[property];if(!graphics)continue;
        let saved=this.records.get(entity);
        if(!saved||saved.graphics!==graphics){saved={graphics,reference:graphics.heightReference,adjusted:false};this.records.set(entity,saved);}
        if(saved.adjusted){graphics.heightReference=saved.reference;saved.adjusted=false;}
        if(entity.show===false)continue;
        const p=entity.position?.getValue?entity.position.getValue(v.clock?.currentTime):entity.position;
        if(!p)continue;
        let c;try{c=C.Cartographic.fromCartesian(p);}catch{continue;}
        if(!c)continue;
        const deck=this.environment.surfaceHeightAt?.(C.Math.toDegrees(c.longitude),C.Math.toDegrees(c.latitude),rec.displayState?.heading??rec.state?.heading);
        if(!Number.isFinite(deck))continue;
        // The normal scene update just wrote a relative-to-ground local height.
        entity.position=C.Cartesian3.fromRadians(c.longitude,c.latitude,deck+c.height);
        graphics.heightReference=C.HeightReference.NONE;saved.adjusted=true;
      }
    }
    if(this.records.size>24){for(const [entity,saved]of this.records)if(!v.entities?.contains?.(entity))this.records.delete(entity);}
  }
  detach(){
    if(this.scene&&this.originalHeight)this.scene._height=this.originalHeight;
    for(const saved of this.records.values())if(saved.adjusted)saved.graphics.heightReference=saved.reference;
    this.records.clear();this.scene=null;this.originalHeight=null;
  }
  destroy(){this.detach();}
}
