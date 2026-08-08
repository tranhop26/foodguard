const proofSteps = [
  {
    number: "01",
    title: "Khóa cam kết món",
    body: "Tên món, số lượng, điều kiện và giá được đưa vào manifest trước khi đặt.",
  },
  {
    number: "02",
    title: "Gắn bằng chứng công khai",
    body: "JSON công khai được chuẩn hóa và gắn với SHA-256 để phát hiện nội dung bị thay đổi.",
  },
  {
    number: "03",
    title: "Đối chiếu rồi phân bổ",
    body: "Khi có contract thật, validator mới đánh giá bằng chứng; UI chỉ cập nhật sau readback.",
  },
];

export function ProofStrip() {
  return (
    <section className="proof-strip" aria-labelledby="proof-title">
      <div className="proof-strip__intro">
        <p className="eyebrow eyebrow--light">Proof, không phải lời hứa</p>
        <h2 id="proof-title">Một đơn món ăn, ba lớp có thể kiểm tra.</h2>
        <p>
          Đây là bản demo quy trình. Băm SHA-256 giúp phát hiện thay đổi nhưng
          không tự bảo đảm món ăn đúng; kết quả vẫn phụ thuộc bằng chứng hợp lệ
          và đồng thuận mạng.
        </p>
      </div>

      <ol className="proof-strip__steps">
        {proofSteps.map((step) => (
          <li key={step.number}>
            <span className="proof-strip__number">{step.number}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="proof-strip__disclosure">
        <span className="proof-strip__disclosure-icon" aria-hidden="true">i</span>
        <p>
          <strong>Giá trị mô phỏng.</strong> Simulated GEN trên StudioNet không
          phải tiền thật hay thanh toán sản xuất.
        </p>
      </div>
    </section>
  );
}
