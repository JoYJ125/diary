require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// KST 오늘 날짜 (YYYY-MM-DD)
const getKSTDateString = () => {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().split('T')[0];
};

// 1. 전체 데이터 JSON 파일 내보내기 API
app.get('/api/export', async (req, res) => {
  try {
    const exportData = {
      exported_at: new Date().toISOString(),
      plans: [],
      todos: [],
      execution_logs: [],
      reviews: []
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="plandosee_backup.json"');
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. TODO 목록 (검색, 필터, 지연/막힘, 정렬) API
app.get('/api/todos', async (req, res) => {
  const { plan_id = 1, search, status, filter_type, sort_by = 'due_date' } = req.query;

  try {
    // DB 연결 제거 상태 - 응답 인터페이스 유지용 빈 배열
    res.json([]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 할 일 신규 등록 API
app.post('/api/todos', async (req, res) => {
  const { plan_id = 1, content, due_date, priority = 'MEDIUM', tags = '', estimated_hours = 0 } = req.body;

  if (!content) {
    return res.status(400).json({ error: '할 일 내용을 입력해주세요.' });
  }

  try {
    // DB 연결 제거 상태 - 성공 응답 목업
    res.status(201).json({
      id: Date.now(),
      plan_id,
      content,
      status: 'IN_PROGRESS',
      due_date: due_date || null,
      priority,
      tags,
      estimated_hours
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. 할 일 완료 처리 API
app.post('/api/todos/:id/complete', async (req, res) => {
  const todoId = req.params.id;
  const { actual_hours, obstacle_reason } = req.body;

  try {
    res.json({ success: true, todoId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. SEE 돌아보기 집계 요약 API
app.get('/api/plans/:id/review-summary', async (req, res) => {
  try {
    res.json({
      total_plans: 0,
      completed_count: 0,
      delayed_count: 0,
      blocked_count: 0,
      total_estimated_hours: 0,
      total_actual_hours: 0,
      time_difference: 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 백엔드 서버가 포트 ${PORT}에서 실행 중입니다.`));
