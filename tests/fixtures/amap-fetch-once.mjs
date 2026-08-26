let geocodeCalls = 0;
let poiCalls = 0;

function json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.pathname === "/v3/geocode/geo") {
    geocodeCalls += 1;
    if (geocodeCalls > 1) throw new Error("geocode repeated during cursor continuation");
    return json({
      status: "1",
      info: "OK",
      infocode: "10000",
      count: "1",
      geocodes: [{
        formatted_address: "广东省深圳市南山区云科技大厦",
        country: "中国",
        province: "广东省",
        city: "深圳市",
        district: "南山区",
        adcode: "440305",
        location: "113.950000,22.540000",
        level: "门牌号",
      }],
    });
  }
  if (url.pathname === "/v5/place/around") {
    poiCalls += 1;
    if (poiCalls > 1) throw new Error("Amap POI scan repeated during cursor continuation");
    const pois = ["甲", "乙", "丙"].map((name, index) => ({
      id: `fixture-${index}`,
      name: `${name}店`,
      type: "餐饮服务;中餐厅;中餐厅",
      typecode: "050100",
      address: `科苑路${index + 1}号`,
      location: `113.950${index + 1}00,22.540000`,
      pname: "广东省",
      cityname: "深圳市",
      adname: "南山区",
    }));
    return json({ status: "1", info: "OK", infocode: "10000", count: "3", pois });
  }
  throw new Error(`unexpected fixture endpoint: ${url.pathname}`);
};
